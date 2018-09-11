'use strict'
const awsServerlessExpressMiddleware = require('aws-serverless-express/middleware');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const AWS = require('aws-sdk');
const voiceit2 = require('voiceit2-nodejs');
const url = require('url');
const moment = require('moment');

const app = express();
const router = express.Router();
app.use(bodyParser());

router.use(awsServerlessExpressMiddleware.eventContext())
let myVoiceIt = new voiceit2(process.env.VIAPIKEY, process.env.VIAPITOKEN);

AWS.config.update({
  region: 'us-east-1',
});
var docClient = new AWS.DynamoDB.DocumentClient();

router.get('/twilioserver', (req, res) => {
  res.send('VoiceIt Amazon Connect/Twilio integration Demo. Please try calling 786-864-5177 to test it out.');
});

const getNumberOfEnrollments = (phoneNumber, callback) => {

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
        callback(data.Items[0].info.numEnrollments);
      }
  });
}

const setNumberOfEnrollments = (phoneNumber, numEnrollments, callback) => {

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

}

const setSuccessfulAuthentication = (phoneNumber, callback) => {

  let params = {
    TableName: 'ConnectTwilio',
    Key:{
      'phoneNumber': phoneNumber,
    },
    UpdateExpression: 'set info.verified = :v, info.authTime = :t',
    ExpressionAttributeValues:{
      ':v':true,
      ':t':moment().format(moment.defaultFormatUtc),
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


router.post('/twilioserver', (req, res) => {
  const phoneNumber = req.body.From;
  const parsedUrl = url.parse(req.url, true)
  const param = req.query.param;

  getNumberOfEnrollments(phoneNumber, (numEnrollments) => {
  
    if (param === 'processverify') {
      processverify(req, res, phoneNumber, req.query.userId);
    } else if  (param === 'processenroll') {
      processenroll(req, res, phoneNumber, req.query.userId, numEnrollments);
    } else {

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
              if (data.Items[0].phoneNumber === '') {
                const twiml = new VoiceResponse();
                twiml.say({voice: 'alice'}, 'User phone number not found in the database.');
                res.type('text/xml');
                res.send(twiml.toString());
              } else if (data.Items[0].info.verifying && !data.Items[0].info.enrolling) {
                verify(res, res, phoneNumber, data.Items[0].info.userId);
              } else if (!data.Items[0].info.verifying && data.Items[0].info.enrolling) {
                enroll(res, res, phoneNumber, data.Items[0].info.userId);
              } else {
                const twiml = new VoiceResponse();
                twiml.say({voice: 'alice'}, 'either both veryfing/enrolling is set to true, or both is set to false. Please check previous function call on the Amazon Connect Side.');
                res.type('text/xml');
                res.send(twiml.toString());
              }
          }
      });

    }
  
  });


});

const enroll = (req, res, phoneNumber, userId) => {

  const twiml = new VoiceResponse();
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
      twiml.say({voice: 'alice'}, 'Please state the phrase, ' + process.env.PHRASE + ', after the tone.');
      twiml.record({
        action: 'twilioserver?param=processenroll&userId=' + userId,
        trim: 'do-not-trim',
        maxLength: 5,
      });
      res.type('text/xml');
      res.send(twiml.toString());
    }
  });
  
}

const verify = (req, res, phoneNumber, userId) => {

  const twiml = new VoiceResponse();
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
      twiml.say({voice: 'alice'}, 'Please state the phrase, ' + process.env.PHRASE + ', after the tone.');
      twiml.record({
        action: 'twilioserver?param=processverify&userId=' + userId,
        trim: 'do-not-trim',
        maxLength: 5,
      });
      res.type('text/xml');
      res.send(twiml.toString());
    }
  });

}

// processverify(req, res, req.query.userId);
const processverify = (req, res, phoneNumber, userId) => {
  const twiml = new VoiceResponse();
  const voiceUrl = req.body.RecordingUrl + '.wav';

  myVoiceIt.voiceVerificationByUrl({
    userId: userId,
    contentLanguage: 'en-US',
    phrase: process.env.PHRASE,
    audioFileURL: voiceUrl,
  }, (json) => {
    if (json['status'] === 200 && json['responseCode'] === 'SUCC') {
      setSuccessfulAuthentication(phoneNumber, () => {
        twiml.say({voice: 'alice'}, 'Successfuly verified. Transferring back to Connect as a verified user.');
        twiml.dial('786-864-5177');
        res.type('text/xml');
        res.send(twiml.toString());
      });
    } else {
      twiml.say({voice: 'alice'}, 'Failed to verify. Please try again by stating the phrase, never forget tomorrow is a new day, after the tone.');
      twiml.record({
        action: 'twilioserver?param=processverify' + '&userId=' + userId,
        trim: 'do-not-trim',
        maxLength: 5,
        });
      res.type('text/xml');
      res.send(twiml.toString());
    }
  });

}

const processenroll = (req, res, phoneNumber, userId, numEnrollments) => {
  numEnrollments += 1;

  const twiml = new VoiceResponse();
  const voiceUrl = req.body.RecordingUrl + '.wav';

  if (numEnrollments == 3) {

    myVoiceIt.createVoiceEnrollmentByUrl({
      userId: userId,
      contentLanguage: 'en-US',
      phrase: process.env.PHRASE,
      audioFileURL: voiceUrl,
    }, (json) => {
      if (json['responseCode'] === 'SUCC') {
        setNumberOfEnrollments(phoneNumber, 3, () => {
          twiml.say({voice: 'alice'}, 'We successfully enrolled you in our system. We will now transfer your call back to Amazon Connect to authenticate.');
          twiml.dial('786-864-5177');
          res.type('text/xml');
          res.send(twiml.toString());
        });
      } else {
        twiml.say({voice: 'alice'}, 'Last enrollment failed. Please repeat the phrase, ' + process.env.PHRASE + ', after the tone.');
        twiml.record({
          action: 'twilioserver?param=processenroll' + '&userId=' + userId,
          trim: 'do-not-trim',
          maxLength: 5,
        });
        res.type('text/xml');
        res.send(twiml.toString());
      }
    });

  } else {

    myVoiceIt.createVoiceEnrollmentByUrl({
      userId: userId,
      contentLanguage: 'en-US',
      phrase: process.env.PHRASE,
      audioFileURL: voiceUrl,
    }, (json) => {
      if (json['responseCode'] === 'SUCC') {
        setNumberOfEnrollments(phoneNumber, numEnrollments, () => {
          twiml.say({voice: 'alice'}, 'Please repeat the phrase, ' + process.env.PHRASE + ', after the tone.')
          twiml.record({
            action: 'twilioserver?param=processenroll' + '&userId=' + userId,
            trim: 'do-not-trim',
            maxLength: 5,
          });
          res.type('text/xml');
          res.send(twiml.toString());
        });
      } else {
        twiml.say({voice: 'alice'}, 'Last enrollment failed. Please repeat the phrase, ' + process.env.PHRASE + ', after the tone.')
        twiml.record({
          action: 'twilioserver?param=processenroll' + '&userId=' + userId,
          trim: 'do-not-trim',
          maxLength: 5,
        });
        res.type('text/xml');
        res.send(twiml.toString());
      }
    });
  
  }

}

app.use('/', router)
module.exports = app
