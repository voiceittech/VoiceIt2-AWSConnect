package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/dynamodb/dynamodbattribute"
	voiceit2 "github.com/voiceittech/VoiceIt2-Go"
	"github.com/voiceittech/VoiceIt2-Go/structs"
)

var (
	myVoiceIt voiceit2.VoiceIt2
)

type ItemInfo struct {
	UserId         string `json:"userId"`
	Verifying      bool   `json:"verifying"`
	Enrolling      bool   `json:"enrolling"`
	NumEnrollments int    `json:"numEnrollments"`
	Verified       bool   `json:"verified"`
	AuthTime       string `json:"authTime"`
}

type Item struct {
	PhoneNumber string   `json:"phoneNumber"`
	Info        ItemInfo `json:"info"`
}

func Handler(ctx context.Context, connectEvent events.ConnectEvent) (events.ConnectResponse, error) {

	sess, err := session.NewSession(&aws.Config{
		Region: aws.String("us-east-1")},
	)

	if err != nil {
		fmt.Println("Got error creating session:")
		fmt.Println(err.Error())
		return nil, err
	}

	// Declare new DynamoDB session
	svc := dynamodb.New(sess)

	// Grab element using primary key "phoneNumber" which is provided by the connectEvent struct and is passed by Amazon Connect to this lambda function
	result, err := svc.GetItem(&dynamodb.GetItemInput{
		TableName: aws.String("ConnectTwilio"),
		Key: map[string]*dynamodb.AttributeValue{
			"phoneNumber": {
				S: aws.String(connectEvent.Details.ContactData.CustomerEndpoint.Address),
			},
		},
	})

	if err != nil {
		log.Println("Unable to run svc.GetItem()")
		log.Println(err.Error())
		return nil, err
	}

	// Convert dynamodb object to native stuct Item{} defined above
	item := Item{}
	err = dynamodbattribute.UnmarshalMap(result.Item, &item)

	if err != nil {
		log.Printf("Failed to unmarshal Record, %v", err)
	}

	if item.PhoneNumber == "" { // Empty phone number field means no such entry exists in the DynamoDB database, and we should enroll the user
		return EnrollFromScratch(ctx, connectEvent.Details.ContactData.CustomerEndpoint.Address, svc)
	} else if item.Info.Verified { // Verified gets set by the Twilio server, and hence, if it is true, the user successfully authenticated at some point in the past.
		return Verified(ctx, connectEvent.Details.ContactData.CustomerEndpoint.Address, item.Info.AuthTime, svc)
	} else if item.Info.NumEnrollments < 3 { // If user phone number is in the DynamoDB database, but the enrolled attribute was not set to true, it means the user cut the call during Twilio enrollment process, and the enrollments never went through.
		// Another possibility here is to call the myVoiceIt.GetAllVoiceEnrollments(<userId>) function to see if the variable "count" is more than 0
		return Enroll(ctx, connectEvent.Details.ContactData.CustomerEndpoint.Address, svc)
	} else { // If phone number not empty and user is enrolled, it means the user previously enrolled, therefore, move to verify the user
		return Verify(ctx, connectEvent.Details.ContactData.CustomerEndpoint.Address, svc)
	}
}

func EnrollFromScratch(ctx context.Context, phoneNumber string, svc *dynamodb.DynamoDB) (events.ConnectResponse, error) {

	// Call CreateUser() and unmarshal that into the createuserreturn struct so that we can easily extract the values
	var createuserreturn structs.CreateUserReturn
	json.Unmarshal([]byte(myVoiceIt.CreateUser()), &createuserreturn)
	userId := createuserreturn.UserId

	// Declare a new Item{} struct with the user's phone number, and userId
	// Furthermore, declare the Info.Enrolling variable to be true since we want to enroll the user

	item := Item{
		PhoneNumber: phoneNumber,
		Info: ItemInfo{
			UserId:         userId,
			Verifying:      false,
			Enrolling:      true,
			Verified:       false,
			AuthTime:       time.Now().Format(time.RFC3339),
			NumEnrollments: 0,
		},
	}

	av, err := dynamodbattribute.MarshalMap(item)
	if err != nil {
		log.Println("Error marshelling struct to dynamodbattribute object:")
		log.Println(err.Error())
	}

	input := dynamodb.PutItemInput{
		Item:      av,
		TableName: aws.String("ConnectTwilio"),
	}

	_, err = svc.PutItem(&input)
	if err != nil {
		log.Println("Got error calling PutItem:")
		log.Println(err.Error())
	} else {
		log.Println("Successfuly created new item", item)
	}

	return events.ConnectResponse{
		"Branch": "enrollfromscratch",
	}, nil
}

func Enroll(ctx context.Context, phoneNumber string, svc *dynamodb.DynamoDB) (events.ConnectResponse, error) {
	input := dynamodb.UpdateItemInput{
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":v": {
				BOOL: aws.Bool(false),
			},
			":e": {
				BOOL: aws.Bool(true),
			},
		},
		TableName: aws.String("ConnectTwilio"),
		Key: map[string]*dynamodb.AttributeValue{
			"phoneNumber": {
				S: aws.String(phoneNumber),
			},
		},
		ReturnValues:     aws.String("UPDATED_NEW"),
		UpdateExpression: aws.String("set info.verifying = :v, info.enrolling = :e"),
	}

	_, err := svc.UpdateItem(&input)
	if err != nil {
		log.Println("Error: unable to execute svc.UpdateItem()")
		log.Println(err.Error())
	} else {
		log.Println("Successfuly updated info.enrolling to be true")
	}

	return events.ConnectResponse{
		"Branch": "enroll",
	}, nil
}

func Verify(ctx context.Context, phoneNumber string, svc *dynamodb.DynamoDB) (events.ConnectResponse, error) {

	input := dynamodb.UpdateItemInput{
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":v": {
				BOOL: aws.Bool(true),
			},
			":e": {
				BOOL: aws.Bool(false),
			},
		},
		TableName: aws.String("ConnectTwilio"),
		Key: map[string]*dynamodb.AttributeValue{
			"phoneNumber": {
				S: aws.String(phoneNumber),
			},
		},
		ReturnValues:     aws.String("UPDATED_NEW"),
		UpdateExpression: aws.String("set info.verifying = :v, info.enrolling = :e"),
	}

	_, err := svc.UpdateItem(&input)
	if err != nil {
		log.Println("Error: unable to execute svc.UpdateItem()")
		log.Println(err.Error())
	} else {
		log.Println("Successfuly updated info.verify to be true")
	}

	return events.ConnectResponse{
		"Branch": "verify",
	}, nil

}

func Verified(ctx context.Context, phoneNumber string, timeString string, svc *dynamodb.DynamoDB) (events.ConnectResponse, error) {
	dbTime, err := time.Parse(time.RFC3339, timeString)
	if err != nil {
		log.Println("Failed to parse time stored in DynamoDB database")
		log.Println(err.Error())
	}
	if time.Now().Sub(dbTime) < 10*time.Second { // Verification occured recently (not prior to 10 seconds ago)

		input := dynamodb.UpdateItemInput{
			ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
				":v": {
					BOOL: aws.Bool(false),
				},
			},
			TableName: aws.String("ConnectTwilio"),
			Key: map[string]*dynamodb.AttributeValue{
				"phoneNumber": {
					S: aws.String(phoneNumber),
				},
			},
			ReturnValues:     aws.String("UPDATED_NEW"),
			UpdateExpression: aws.String("set info.verified = :v"),
		}

		_, err := svc.UpdateItem(&input)
		if err != nil {
			log.Println("Error: unable to execute svc.UpdateItem()")
			log.Println(err.Error())
		} else {
			log.Println("Successfuly updated info.verified to be false")
		}

		return events.ConnectResponse{
			"Branch": "verified",
		}, nil
	} else { // Verification happened too long ago. Set info.verified to false, and set info.verifying to true in order have the user verify from scratch.

		input := dynamodb.UpdateItemInput{
			ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
				":verified": {
					BOOL: aws.Bool(false),
				},
				":verifying": {
					BOOL: aws.Bool(true),
				},
			},
			TableName: aws.String("ConnectTwilio"),
			Key: map[string]*dynamodb.AttributeValue{
				"phoneNumber": {
					S: aws.String(phoneNumber),
				},
			},
			ReturnValues:     aws.String("UPDATED_NEW"),
			UpdateExpression: aws.String("set info.verified = :verified, info.verifying = :verifying"),
		}

		_, err := svc.UpdateItem(&input)
		if err != nil {
			log.Println("Error: unable to execute svc.UpdateItem()")
			log.Println(err.Error())
		} else {
			log.Println("Successfuly updated info.verified to be false, and info.verifying to be true")
		}

		return events.ConnectResponse{
			"Branch": "failedverified",
		}, nil
	}
}

func init() {
	myVoiceIt = *voiceit2.NewClient(os.Getenv("VIAPIKEY"), os.Getenv("VIAPITOKEN"))
}

func main() {
	lambda.Start(Handler)
}
