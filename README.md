# jokear-meet

jokear-meet is a solution designed to deploy large-scale video conferencing systems. Based on WebRTC for real-time communication, it handles video calls, audio, and screen sharing. Optimized for scalability, this solution easily integrates into complex infrastructures, providing a robust and secure foundation for high-performance teleconferencing applications.

## install

```shell
# npm
npm install mediasoup@3 jokear-meet

# yarn
yarn add mediasoup@3 jokear-meet
```

## usage

```javascript
import { JokearMeet } from "jokear-meet";

const jockearMeet = new JokearMeet(server);
await jockearMeet.initialized();
```
