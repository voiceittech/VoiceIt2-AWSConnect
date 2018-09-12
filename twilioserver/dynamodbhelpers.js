// Helper functions to set and get data from DynamoDB

const AWS = require('aws-sdk'); // npm i aws-sdk --save [note: Installation not necessary if using on AWS Lambda as it automatically gets installed; credentials are also handled by Lambda]
const moment = require('moment'); // npm i moment --save

// Configure AWS SDK to use 'us-east-1' (Set to whatever Location you set up your DynamoDB table that you will be using)
AWS.config.update({
  region: 'us-east-1',
});
const docClient = new AWS.DynamoDB.DocumentClient();

const dynamodbhelpers = {

  getUserObject : (phoneNumber, callback) => { // Get the User Object from DynamoDB
    const params = {
      TableName : 'ConnectTwilio',
      KeyConditionExpression: '#phonenumber = :num',
      ExpressionAttributeNames:{
          '#phonenumber': 'phoneNumber'
      },
      ExpressionAttributeValues: {
          ':num': phoneNumber
      }
    }
    docClient.query(params, (err, data) => {
        if (err) {
            console.error('Unable to query. Error:', JSON.stringify(err, null, 2));
        } else {
          callback(data.Items[0]);  // Note, since a simple query will return a list of all results that match the parameter, and we know that there is exactly 1 item that matches the parameter, use data.Items[0] to reference element 1 of 1 of data.Items.
        }
    });
  },

  setNumberOfEnrollments : (phoneNumber, numEnrollments, callback) => { // Set number of Enrollments to numEnrollments in DynamoDB
    let params = {
      TableName: 'ConnectTwilio',
      Key:{
        'phoneNumber': phoneNumber,
      },
      UpdateExpression: 'set info.numEnrollments = :num',
      ExpressionAttributeValues:{
        ':num':numEnrollments,
      },
      ReturnValues:'UPDATED_NEW'
    };
    docClient.update(params, (err, data) => {
      if (err) {
        console.error('Unable to update item. Error JSON:', JSON.stringify(err, null, 2));
      } else {
        callback();
      }
    });
  },

  setSuccessfulAuthentication : (phoneNumber, callback) => { // Set info.verified to true, and the current time in info.authTime in DynamoDB (info.verified == true will only be valid if the timestamp is no older than 7 seconds back in Amazon Connect logic)
    let params = {
      TableName: 'ConnectTwilio',
      Key:{
        'phoneNumber': phoneNumber,
      },
      UpdateExpression: 'set info.verified = :v, info.authTime = :t',
      ExpressionAttributeValues:{
        ':v':true,
        ':t':moment().format(moment.defaultFormatUtc), // Save the string form of the current time as RFC3339
      },
      ReturnValues:'UPDATED_NEW'
    };
    docClient.update(params, (err, data) => {
      if (err) {
        console.error('Unable to update item. Error JSON:', JSON.stringify(err, null, 2));
      } else {
        callback();
      }
    });
  },

  setEnrollingVerifyingFalse : (phoneNumber, callback) => { // Set both info.verifying and info.enrolling to be false in DynamoDB
    let params = {
      TableName: 'ConnectTwilio',
      Key:{
        'phoneNumber': phoneNumber,
      },
      UpdateExpression: 'set info.verifying = :v, info.enrolling=:e',
      ExpressionAttributeValues:{
        ':v':false,
        ':e':false,
      },
      ReturnValues:'UPDATED_NEW'
    };
    docClient.update(params, (err, data) => {
      if (err) {
        console.error('Unable to update item. Error JSON:', JSON.stringify(err, null, 2));
      } else {
        callback();
      }
    });
  }
};

module.exports = dynamodbhelpers;
