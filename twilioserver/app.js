// Main program logic
// Defines the endpoints and functions

'use strict'
const awsServerlessExpressMiddleware = require('aws-serverless-express/middleware');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const VoiceResponse = require('twilio').twiml.VoiceResponse; // npm i twilio --save
const voiceit2 = require('voiceit2-nodejs'); // npm i voiceit2-nodejs --save
const url = require('url');
const dynamodbhelpers = require('./dynamodbhelpers');

const app = express();
const router = express.Router();
app.use(bodyParser());

router.use(awsServerlessExpressMiddleware.eventContext()); // Use aws-serverless-express/middleware event context for our application
let myVoiceIt = new voiceit2(process.env.VIAPIKEY, process.env.VIAPITOKEN); // initialize VoiceIt2 object

// The get endpoint '/appname' is a stripped down info site which can be accessed by typing the Application's API Gateway URL into the browser
router.get('/' + process.env.APPNAME, (req, res) => {
  res.send('VoiceIt Amazon Connect/Twilio integration Demo. Please try calling ' + process.env.AMAZONCONNECTPHONENUMBER + ' to test it out.');
});


// First entry point for Twilio calls.
// Once you set up your Twilio account, request a phone number, and use the Twilio Web Console to set that phone number to do a POST request to this endpoint (the exact URL of the endpoint can be seen when you
router.post('/' + process.env.APPNAME, (req, res) => {
  const phoneNumber = req.body.From;

  // When this function is initially invoked (i.e. the phone number that POSTS to this endpoint is called), param will be null
  // However, other parts of this program will also POST to this endpoint in order to follow a recursive program flow (the Twilio audio recording URL needs to be taken from a request)...
  // (which cannot updated with the URL value without triggering another POST request after the audio is recorded)
  const param = req.query.param;

  dynamodbhelpers.getUserObject(phoneNumber, (userObject) => { // Get user object from DynamoDB
  
    // If param is 'processverify' or 'processenroll', it means function that made the POST request recorded audio, and wants to extract the audio's URL using the req variable in order to do a request to VoiceIt's URL
    if (param === 'processverify') {
      processverify(req, res, phoneNumber, userObject.info.userId);
    } else if  (param === 'processenroll') {
      processenroll(req, res, phoneNumber, userObject.info.userId, userObject.info.numEnrollments);

    } else { // If neither of the above scenarios are true, it means this function was triggered directly by Amazon Connect and we should figure out what Amazon Connect wanted us to do using the values it modified in DynamoDB

      if (userObject.phoneNumber === '') {
        const twiml = new VoiceResponse(); // object twiml is a helper function which structures TWIML (a specialized form of XML used to communicate with Twilio's API), and is sent as a response to Twilio in order to trigger a Twilio action.
        twiml.say({voice: 'alice'}, 'User phone number not found in the database.'); // add "say 'User phone number not found in the database'" to the list of actions we want Twilio to do
        res.type('text/xml');
        res.send(twiml.toString()); // Execute the "say '...'" action above to have Twilio play prompt to user

      } else if (userObject.info.verifying && !userObject.info.enrolling) { // Amazon Connect wrote in DynamoDB that they want this program to verify the user
        verify(res, res, phoneNumber, userObject.info.userId);

      } else if (!userObject.info.verifying && userObject.info.enrolling) { // Amazon Connect wrote in DynamoDB that they want this program to enroll the user
        enroll(res, res, phoneNumber, userObject.info.userId);

      } else { // Invalid option: either both verifying & enrolling are set to true, or both are set to false.
        const twiml = new VoiceResponse();
        twiml.say({voice: 'alice'}, 'either both veryfing/enrolling is set to true, or both is set to false. Please check previous function call on the Amazon Connect Side.');
        res.type('text/xml');
        res.send(twiml.toString());
      }

    }
  });
});

const enroll = (req, res, phoneNumber, userId) => { // Enrollment initializer function
  const twiml = new VoiceResponse();
  
  dynamodbhelpers.setEnrollingVerifyingFalse(phoneNumber, () => { // set both enrolling and verifying variables to be false
    twiml.say({voice: 'alice'}, 'Please state the phrase, ' + process.env.PHRASE + ', after the tone.');
    twiml.record({ // This time, on top of having Twilio playing a prompt, we want Twilio to record a 5 second audio clip from the user (which we will use to enroll them to VoiceIt)
      action: process.env.APPNAME + '?param=processenroll', // Note, we will be triggering another /appname POST request, but this time including param=processenroll [see explanation of param parameter above to see more]
      trim: 'do-not-trim',
      maxLength: 5,
    });
    res.type('text/xml');
    res.send(twiml.toString()); // Send the play prompt request and record audio request to Twilio
  })
}

const verify = (req, res, phoneNumber, userId) => { // Verify intializer function
  const twiml = new VoiceResponse();

  dynamodbhelpers.setEnrollingVerifyingFalse(phoneNumber, () => { // set both enrolling and verifying variables to be false
    twiml.say({voice: 'alice'}, 'Please state the phrase, ' + process.env.PHRASE + ', after the tone.');
    twiml.record({
      action: process.env.APPNAME + '?param=processverify', // Note, we will be triggering another /appname POST request, but this time including param=processverify [see at explanation of param parameter above to see more]
      trim: 'do-not-trim',
      maxLength: 5,
    });
    res.type('text/xml');
    res.send(twiml.toString());
  });

}


const processenroll = (req, res, phoneNumber, userId, numEnrollments) => { // Called if the program previously recorded an audio prior to a Twilio redirect that we want to use as an enrollment
  numEnrollments += 1; // Counter for number of enrollments which is retreived from DynamoDB and passed to this function. We need this number because VoiceIt requires at 3 or more successful enrollments in order to verify the user

  const twiml = new VoiceResponse();
  const voiceUrl = req.body.RecordingUrl + '.wav'; // As stated before, now that we sent the recording to Twilio, we can retreive that audio URL from the request

  if (numEnrollments == 3) { // As long as this enrollment succeeds, user will have 3 successful enrollments and we can proceed to transfer them back to Amazon Connect to Verify

    myVoiceIt.createVoiceEnrollmentByUrl({ // See https://api.voiceit.io if you are confused
      userId: userId,
      contentLanguage: 'en-US',
      phrase: process.env.PHRASE,
      audioFileURL: voiceUrl,
    }, (json) => {
      if (json['responseCode'] === 'SUCC') { // If the enrollment succeedes...
        dynamodbhelpers.setNumberOfEnrollments(phoneNumber, 3, () => { // update the number of enrollments on DynamoDB to be 3
          twiml.say({voice: 'alice'}, 'We successfully enrolled you in our system. We will now transfer your call back to Amazon Connect to authenticate.');
          twiml.dial(process.env.AMAZONCONNECTPHONENUMBER); // This time, transfer the call back to Amazon Connect so that the Verification process can start from scratch
          res.type('text/xml');
          res.send(twiml.toString());
        });
      } else { // If the enrollment failed, record another 5 second audio clip, and attempt to run processenroll(...) again using that clip.
        twiml.say({voice: 'alice'}, 'Last enrollment failed. Please repeat the phrase, ' + process.env.PHRASE + ', after the tone.');
        twiml.record({
          action: process.env.APPNAME + '?param=processenroll',
          trim: 'do-not-trim',
          maxLength: 5,
        });
        res.type('text/xml');
        res.send(twiml.toString());
      }
    });

  } else { // We will not have 3 enrollments if this enrollments succeeds...

    myVoiceIt.createVoiceEnrollmentByUrl({
      userId: userId,
      contentLanguage: 'en-US',
      phrase: process.env.PHRASE,
      audioFileURL: voiceUrl,
    }, (json) => {
      if (json['responseCode'] === 'SUCC') { // If the enrollment succeeds...
        dynamodbhelpers.setNumberOfEnrollments(phoneNumber, numEnrollments, () => { // Set the number of enrollments to be the incremented value of numEnrollments
          // Record another audio recording, and redirect back to /appname
          twiml.say({voice: 'alice'}, 'Please repeat the phrase, ' + process.env.PHRASE + ', after the tone.')
          twiml.record({
            action: process.env.APPNAME + '?param=processenroll',
            trim: 'do-not-trim',
            maxLength: 5,
          });
          res.type('text/xml');
          res.send(twiml.toString());
        });
      } else { // If the enrollment failed, record another audio clip and redirect back to /appname without updating the enrollment count on DynamoDB
        twiml.say({voice: 'alice'}, 'Last enrollment failed. Please repeat the phrase, ' + process.env.PHRASE + ', after the tone.')
        twiml.record({
          action: process.env.APPNAME + '?param=processenroll',
          trim: 'do-not-trim',
          maxLength: 5,
        });
        res.type('text/xml');
        res.send(twiml.toString());
      }
    });
  
  }

}


const processverify = (req, res, phoneNumber, userId) => { // Called if the program previously recorded an audio prior to a Twilio redirect prior to a Twilio redirect that we want to use as an enrollment
  const twiml = new VoiceResponse();
  const voiceUrl = req.body.RecordingUrl + '.wav';

  myVoiceIt.voiceVerificationByUrl({
    userId: userId,
    contentLanguage: 'en-US',
    phrase: process.env.PHRASE,
    audioFileURL: voiceUrl,
  }, (json) => {
    if (json['status'] === 200 && json['responseCode'] === 'SUCC') { // If verification succeeded...
      dynamodbhelpers.setSuccessfulAuthentication(phoneNumber, () => { // On DynamoDB, set info.verified to be true, and write the info.authTime to be the current time string in RFC3339 format
        twiml.say({voice: 'alice'}, 'Successfuly verified. Transferring back to Connect as a verified user.');
        twiml.dial(process.env.AMAZONCONNECTPHONENUMBER); // Call back to Amazon Connect once we set the verification success variables
        res.type('text/xml');
        res.send(twiml.toString());
      });
    } else { // If verification failed, repeat the process with another recording
      twiml.say({voice: 'alice'}, 'Failed to verify. Please try again by stating the phrase, never forget tomorrow is a new day, after the tone.');
      twiml.record({
        action: process.env.APPNAME + '?param=processverify',
        trim: 'do-not-trim',
        maxLength: 5,
        });
      res.type('text/xml');
      res.send(twiml.toString());
    }
  });

}

app.use('/', router);
module.exports = app;
