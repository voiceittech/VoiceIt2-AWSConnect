// Primary Driver Program (imports ./app.js)

const awsServerlessExpress = require('aws-serverless-express'); // npm i aws-serverless-express --save
const app = require('./app');

const server = awsServerlessExpress.createServer(app); // Instead of the standard localhost port binding declarations (i.e. app.listen()), we use aws-serverless-express middleware to glue our Express application's interface to the AWS Lambda architecture.
exports.handler = (event, context) => awsServerlessExpress.proxy(server, event, context);
