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
	voiceit2 "github.com/voiceittech/VoiceIt2-Go/v2"
	"github.com/voiceittech/VoiceIt2-Go/v2/structs"
)

var (
	myVoiceIt voiceit2.VoiceIt2
)

type ItemInfo struct { // Struct to model DynamoDB Info object
	UserId         string `json:"userId"`
	Verifying      bool   `json:"verifying"`
	Enrolling      bool   `json:"enrolling"`
	NumEnrollments int    `json:"numEnrollments"`
	Verified       bool   `json:"verified"`
	AuthTime       string `json:"authTime"`
}

type Item struct { // Struct to model DynamoDB User object
	PhoneNumber string   `json:"phoneNumber"`
	Info        ItemInfo `json:"info"`
}

// Golang Handler function which follows the AWS HTTP interface
func Handler(ctx context.Context, connectEvent events.ConnectEvent) (events.ConnectResponse, error) {

	sess, err := session.NewSession(&aws.Config{ // Initialize AWS session (by default, takes credentials from Lambda environment)
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

	// Map DynamoDB object to native Item{} struct defined above
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

// User's first time calling the Connect Number.
// Create the user's entry on DynamoDB and then return to Amazon Connect to progress to the enrollment process on the Twilio server
func EnrollFromScratch(ctx context.Context, phoneNumber string, svc *dynamodb.DynamoDB) (events.ConnectResponse, error) {

	// Call VoiceIt CreateUser() and unmarshal that into the createuserreturn struct so that we can easily extract the UserId
	var createuserreturn structs.CreateUserReturn
	ret, err := myVoiceIt.CreateUser()
	if err != nil {
		log.Println("Error running CreateUser() Call")
		log.Println(err.Error())
	}
	json.Unmarshal(ret, &createuserreturn)
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
			AuthTime:       time.Now().Format(time.RFC3339), // Not explicitly used for any logic, but empty strings are not accepted
			NumEnrollments: 0,
		},
	}

	// Marshal struct to map[string]*dynamodb.AttributeValue so we can send to DynamoDB
	av, err := dynamodbattribute.MarshalMap(item)
	if err != nil {
		log.Println("Error marshaling struct to map[string]*dynamodb.AttributeValue")
		log.Println(err.Error())
	}

	input := dynamodb.PutItemInput{
		Item:      av,
		TableName: aws.String("ConnectTwilio"), // Save to ConnectTwilio table
	}

	_, err = svc.PutItem(&input) // Put entry into DynamoDB database
	if err != nil {
		log.Println("Got error calling PutItem:")
		log.Println(err.Error())
	} else {
		log.Println("Successfuly created new item", item)
	}

	// ConnectResponse return back to Amazon Connect allows the Contact Flow to parse the value "enrollfromscratch" from the key "Branch" as an external value we can use in the Connect Contact Flow GUI
	// This case will trigger Amazon Connect to play the prompt "you do not exist in our system. please prepare to enroll in our system as prompted" and transfer the user to the Twilio Phone number
	return events.ConnectResponse{
		"Branch": "enrollfromscratch",
	}, nil
}

// User's called in the past, but did not manage to enroll 3 successful voice enrollments
// return to Amazon Connect to progress to the enrollment process on the Twilio server
func Enroll(ctx context.Context, phoneNumber string, svc *dynamodb.DynamoDB) (events.ConnectResponse, error) {

	// Set info.enrolling to true and info.verifying to be false
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

	// ConnectResponse return back to Amazon Connect allows the Contact Flow to parse the value "enroll" from the key "Branch" as an external value we can use in the Connect Contact Flow GUI
	// This case will trigger Amazon Connect to play the prompt "it seems you are registered in our system, but you did not enroll an adequate number of voice phrases into our system. Please make sure you do not end the call before we confirm that you are enrolled." and transfer the user to the Twilio Phone number
	return events.ConnectResponse{
		"Branch": "enroll",
	}, nil
}

// User's called in the past, and have 3 successful enrollments
// return to Amazon Connect to progress to the verification process on the Twilio server
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

	// ConnectResponse return back to Amazon Connect allows the Contact Flow to parse the value "verify" from the key "Branch" as an external value we can use in the Connect Contact Flow GUI
	// This case will trigger Amazon Connect to play the prompt "you exist in our system. please prepare to verify as prompted" and transfer the user to the Twilio Phone number
	return events.ConnectResponse{
		"Branch": "verify",
	}, nil

}

// User supposedly verified on Twilio Server using VoiceIt's voice verification process
// To be sure that this verification is valid, check the time stamp to make sure it hasn't been more than 10 seconds
func Verified(ctx context.Context, phoneNumber string, timeString string, svc *dynamodb.DynamoDB) (events.ConnectResponse, error) {
	dbTime, err := time.Parse(time.RFC3339, timeString) // Parse the date/time string object stored in DynamoDB when the user was successfully verified on the Twilio server as a RFC3339 formatted time object
	if err != nil {
		log.Println("Failed to parse time stored in DynamoDB database")
		log.Println(err.Error())
	}
	if time.Now().Sub(dbTime) < 10*time.Second { // Verification occured recently (not prior to 10 seconds ago)

		// Set info.verified to false
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

		// ConnectResponse return back to Amazon Connect allows the Contact Flow to parse the value "verified" from the key "Branch" as an external value we can use in the Connect Contact Flow GUI
		// This case will trigger Amazon Connect to be able to treat the current caller as an authenticated user in the Call Center as long as they are on the line
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

		// ConnectResponse return back to Amazon Connect allows the Contact Flow to parse the value "failverified" from the key "Branch" as an external value we can use in the Connect Contact Flow GUI
		// This case will trigger Amazon Connect to play the prompt "You were verified too long ago. Please prepare to verify again as prompted" and transfer the user to the Twilio Phone number
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
