# vrdog-webapp

## Cloning

To clone the repo, run:
` git clone https://github.com/meziksicht/vrdog-webapp.git`

Frontend code is located in the client directory, backend in the server directory. Worskpaces are specified in the root package.json for both the client and server.
To install dependencies, run
 `npm install`
 in the root directory to install dependencies for both workspaces into a single shared `node_modules` folder.

## Running

`npm start` - packs the testing client and runs the server code. 

The mediasoup server currently listens to a random port that gets printed out into the console:

`RTP port: XXXXX`

So to establish an RTP connection with the server, connect to 127.0.0.1:XXXXX, where XXXXX is the port.
