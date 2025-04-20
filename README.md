# vrdog-webapp

## Functionality

The server uses mediasoup to establish a connection between the live video source and the web client, also functioning as a WebRTC signaling server + serving the static mockup client (yet).

An RTP producer is created to server media to the client(s). Mediasoup's internal logic ensures that the RTP source is being sent in a WebRTC-friendly way to ensure it can be displayed on the web.

## Cloning

To clone the repo, run:
` git clone https://github.com/meziksicht/vrdog-webapp.git`

Frontend code is located in the client directory, backend in the server directory. Worskpaces are specified in the root package.json for both the client and server.
To install dependencies, run
 `npm install`
 in the root directory to install dependencies for both workspaces into a single shared `node_modules` folder.

## Running

`npm start` - packs the testing client with webpack and runs the server code.

The mediasoup server currently listens to a random port that gets printed out into the console:

`RTP port: XXXXX`

And listens to data identified by ssrc:

`sssrc: 22222222`

So to establish an RTP connection with the server, connect to 127.0.0.1:XXXXX, where XXXXX is the port, and set the ssrc to 22222222.

Live video was tested on a local machine with ffmpeg:

```
ffmpeg -re -stream_loop -1 -i sample2.mp4 -an -c:v libx264 -profile:v baseline -level 3.2 -b:v 2000k -x264opts keyint=30:min-keyint=30:no-scenecut -ssrc 22222222 -f rtp rtp://127.0.0.1:XXXXX
```
