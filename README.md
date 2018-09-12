# Amazon Connect & VoiceIt Integration Demo
### Andrew Lee
---

We created this repository for our clients who want to integrate our services with Amazon Connect's Call Center functionality.

Both programs are intended to run on AWS Lambda as part of a serverless architecture. They are in a sense, intended to run together, and utilize AWS DynamoDB to "glue" together their logic as well as ensure a secure way to signal a successful authentication from Twilio's server back to Amazon Connect.

The directory structure is as follows:

| *Path* | *Language* | *Description* |
| -- | -- | -- |
| [/connect-twilio-initial](./connect-twilio-initial) | Go | Server which encompasses the initial server side logic when the user calls Amazon Connect |
| [/twilioserver](./twilioserver) | NodeJS | Server that handles call recording using using Twilio's API |

If you need help setting up your workflow, see [exampleconnectvoiceit](./exampleconnectvoiceit) for inspiration.
![example_screenshot](./screenshot.png)
