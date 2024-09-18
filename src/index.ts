import { Server, Socket } from "socket.io";
import * as mediasoup from "mediasoup";

export interface JokearMeetOptions {
  mediasoup?: {
    /**
     * See https://mediasoup.org/documentation/v3/mediasoup/api/#RouterOptions
     * @default
     *{
     *  mediaCodecs: [
     *    { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
     *    { kind: "video", mimeType: "video/VP8", clockRate: 90000, parameters: { "x-google-start-bitrate": 1000 } },
     *  ]
     *}
     */
    routerOptions?: {
      mediaCodecs: mediasoup.types.RtpCodecCapability[];
    };

    /**
     * See https://mediasoup.org/documentation/v3/mediasoup/api/#WorkerSettings
     *
     * @default
     * {
     *    logLevel: "error",
     *    logTags: [],
     *    dtlsCertificateFile: "",
     *    dtlsPrivateKeyFile: "",
     *    rtcMinPort: 40000,
     *    rtcMaxPort: 49999,
     * }
     */
    workerSettings?: mediasoup.types.WorkerSettings;

    /**
     * See https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
     *
     * @default
     * {
     *   listenIps: [{ ip: "0.0.0.0", announcedIp: "127.0.0.1" }],
     *   enableUdp: true,
     *   enableTcp: true,
     *   preferUdp: true,
     * };
     */
    webRtcTransportOptions?: mediasoup.types.WebRtcTransportOptions;

    /** @default false */
    useWebRtcServer?: boolean;

    /**
     * See https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcServerOptions
     */
    webRtcServerOptions?: mediasoup.types.WebRtcServerOptions;
  };
}

export class JokearMeet {
  server: Server;
  options: JokearMeetOptions;

  worker!: mediasoup.types.Worker;
  rooms: {
    [x: string]: {
      router: mediasoup.types.Router<mediasoup.types.AppData>;
      peers: string[];
      audioLevelObserver: mediasoup.types.AudioLevelObserver<mediasoup.types.AppData>;
    };
  } = {};
  peers: {
    [x: string]: {
      socket: Socket;
      roomName: string;
      transports: string[];
      producers: any[];
      consumers: any[];
      peerDetails: any;
    };
  } = {};
  transports: {
    socketId: string;
    transport: mediasoup.types.WebRtcTransport<mediasoup.types.AppData>;
    roomName: string;
    consumer: any;
  }[] = [];
  producers: {
    socketId: string;
    producer: mediasoup.types.Producer<mediasoup.types.AppData>;
    roomName: string;
  }[] = [];
  consumers: {
    consumer: mediasoup.types.Consumer<mediasoup.types.AppData>;
    socketId: string;
    roomName: string;
  }[] = [];

  constructor(server: Server, options?: JokearMeetOptions) {
    this.server = server;
    this.options = options || {};
  }

  async initialized() {
    this.worker = await mediasoup.createWorker(
      this.options.mediasoup?.workerSettings || {
        logLevel: "error",
        logTags: [],
        dtlsCertificateFile: "",
        dtlsPrivateKeyFile: "",
        rtcMinPort: 40000,
        rtcMaxPort: 49999,
      }
    );

    // Create a WebRtcServer in this Worker.
    if (
      this.options.mediasoup?.useWebRtcServer &&
      this.options.mediasoup?.webRtcServerOptions
    ) {
      // Each mediasoup Worker will run its own WebRtcServer, so those cannot
      // share the same listening ports. Hence we increase the value in config.js
      // for each Worker.
      const webRtcServerOptions = this.options.mediasoup.webRtcServerOptions;
      const webRtcServer = await this.worker.createWebRtcServer(
        webRtcServerOptions
      );

      this.worker.appData.webRtcServer = webRtcServer;
    }

    const fns = {
      joinRoom: "joinRoom",
      createWebRtcTransport: "createWebRtcTransport",
      getProducers: "getProducers",
      "transport-connect": "transportConnect",
      "transport-produce": "transportProduce",
      "transport-recv-connect": "transportRecvConnect",
      consume: "consume",
      "consumer-resume": "consumerResume",
      "producer-switch": "producerSwitch",
      disconnect: "onDisconnect",
      "quit-meet": "quitMeet",
    };

    this.server.on("connection", (socket: Socket) => {
      for (const event in fns) {
        const fnName: string = fns[event as "joinRoom"];
        socket.on(event, async (data, callback) => {
          const result = await this[fnName as "joinRoom"](socket, data);
          if (typeof callback === "function") callback(result);

          return result;
        });
      }
    });
  }

  quitMeet(socket: Socket) {
    const peer = this.peers[socket.id];
    this.onDisconnect(socket);

    if (peer) {
      const { peerDetails, roomName } = peer;
      if (peerDetails.isAdmin) socket.broadcast.to(roomName).emit("end-meet");
    }

    return {};
  }

  onDisconnect(socket: Socket) {
    // do some cleanup
    console.log("peer disconnected", socket.id);

    this.consumers = this.removeItems(
      socket,
      this.consumers,
      socket.id,
      "consumer"
    );
    this.producers = this.removeItems(
      socket,
      this.producers,
      socket.id,
      "producer"
    );
    this.transports = this.removeItems(
      socket,
      this.transports,
      socket.id,
      "transport"
    );

    const peer = this.peers[socket.id];
    if (peer) {
      const roomName = peer.roomName;
      delete this.peers[socket.id];

      const peers = this.rooms[roomName].peers.filter(
        (socketId) => socketId !== socket.id
      );

      this.rooms[roomName].peers = peers;
    }

    return {};
  }

  async joinRoom(socket: Socket, data: any) {
    const roomName = data.roomName;
    socket.join(roomName);

    const router1 = await this.createRoom(roomName, socket.id);
    this.peers[socket.id] = {
      socket,
      roomName, // Name for the Router this Peer joined
      transports: [],
      producers: [],
      consumers: [],
      peerDetails: data.peerDetails,
    };
    // get Router RTP Capabilities
    const rtpCapabilities = router1.rtpCapabilities;
    // call callback from the client and send back the rtpCapabilities
    // callback({ rtpCapabilities });

    socket.emit("joinRoom", rtpCapabilities);
    return { rtpCapabilities, roomName };
  }

  async createRoom(roomName: string, socketId: string) {
    const mediaCodecs: mediasoup.types.RtpCodecCapability[] = this.options
      .mediasoup?.routerOptions?.mediaCodecs || [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: { "x-google-start-bitrate": 1000 },
      },
    ];

    let router1: mediasoup.types.Router;
    let peers: string[] = [];

    if (this.rooms[roomName]) {
      router1 = this.rooms[roomName].router;
      peers = this.rooms[roomName].peers || [];
    } else {
      router1 = await this.worker.createRouter({ mediaCodecs });
    }

    const audioLevelObserver = await router1.createAudioLevelObserver({
      maxEntries: 1,
      threshold: -80,
      interval: 800,
    });

    audioLevelObserver.on("volumes", (volumes) => {
      const { volume } = volumes[0];
      const { peerDetails } = this.peers[socketId];

      this.server.to(roomName).emit("speaking", {
        peerDetails,
        volume: volume,
      });
    });

    audioLevelObserver.on("silence", () => {
      this.server.to(roomName).emit("silence");
    });

    this.rooms[roomName] = {
      router: router1,
      peers: [...peers, socketId],
      audioLevelObserver,
    };
    return router1;
  }

  async createWebRtcTransport(socket: Socket, data: any) {
    // get Room Name from Peer's properties
    const roomName = this.peers[socket.id].roomName;

    // get Router (Room) object this peer is in based on RoomName
    const router = this.rooms[roomName].router;

    const _createWebRtcTransport = async (
      router: mediasoup.types.Router<mediasoup.types.AppData>
    ) => {
      // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
      const webRtcTransport_options: mediasoup.types.WebRtcTransportOptions<mediasoup.types.AppData> =
        this.options.mediasoup?.webRtcTransportOptions || {
          listenIps: [{ ip: "0.0.0.0", announcedIp: "127.0.0.1" }],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
        };

      return new Promise<
        mediasoup.types.WebRtcTransport<mediasoup.types.AppData>
      >(async (resolve, reject) => {
        try {
          // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
          const transport = await router.createWebRtcTransport(
            webRtcTransport_options
          );

          transport.on("dtlsstatechange", (dtlsState) => {
            if (dtlsState === "closed") {
              transport.close();
            }
          });

          // TODO: @close
          transport.on("close" as any, () => {
            // console.log("transport closed");
          });

          resolve(transport);
        } catch (error) {
          reject(error);
        }
      });
    };

    const transport = await _createWebRtcTransport(router);

    this.addTransport(transport, roomName, data.consumer, socket);

    return {
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    };
  }

  private removeItems(
    socket: Socket,
    items: any[],
    socketId: string,
    type: string
  ) {
    items.forEach((item) => {
      if (item.socketId === socket.id) {
        item[type].close();
      }
    });
    items = items.filter((item) => item.socketId !== socket.id);

    return items;
  }

  private addTransport(
    transport: mediasoup.types.WebRtcTransport<mediasoup.types.AppData>,
    roomName: string,
    consumer: any,
    socket: Socket
  ) {
    const e = { socketId: socket.id, transport, roomName, consumer };
    this.transports = [
      ...this.transports,
      { socketId: socket.id, transport, roomName, consumer },
    ];

    this.peers[socket.id] = {
      ...this.peers[socket.id],
      transports: [...this.peers[socket.id].transports, transport.id],
    };
  }

  private getTransport(socket: Socket) {
    const [producerTransport] = this.transports.filter(
      (transport) => transport.socketId === socket.id && !transport.consumer
    );
    return producerTransport.transport;
  }

  private addProducer(socket: Socket, producer: any, roomName: string) {
    this.producers = [
      ...this.producers,
      { socketId: socket.id, producer, roomName },
    ];

    if (producer.kind === "audio") {
      this.rooms[roomName].audioLevelObserver
        .addProducer({ producerId: producer.id })
        .catch(() => {});
    }

    this.peers[socket.id] = {
      ...this.peers[socket.id],
      producers: [...this.peers[socket.id].producers, producer.id],
    };
  }

  private informConsumers(roomName: string, socketId: string, id: string) {
    // console.log(`just joined, id ${id} ${roomName}, ${socketId}`);
    // A new producer just joined
    // let all consumers to consume this producer
    this.producers.forEach((producerData) => {
      if (
        producerData.socketId !== socketId &&
        producerData.roomName === roomName
      ) {
        const producerSocket = this.peers[producerData.socketId].socket;
        // use socket to send producer id to producer
        producerSocket.emit("new-producer", { producerId: id });
      }
    });
  }

  private addConsumer(
    socket: Socket,
    consumer: mediasoup.types.Consumer<mediasoup.types.AppData>,
    roomName: string
  ) {
    // add the consumer to the consumers list
    this.consumers = [
      ...this.consumers,
      { socketId: socket.id, consumer, roomName },
    ];

    // add the consumer id to the peers list
    this.peers[socket.id] = {
      ...this.peers[socket.id],
      consumers: [...this.peers[socket.id].consumers, consumer.id],
    };
  }

  getProducers(socket: Socket) {
    const { roomName } = this.peers[socket.id];

    let producerList: string[] = [];
    for (const producerData of this.producers) {
      if (
        producerData.socketId !== socket.id &&
        producerData.roomName === roomName
      ) {
        producerList = [...producerList, producerData.producer.id];
      }
    }

    // return the producer list back to the client
    return producerList;
  }

  async transportConnect(socket: Socket, data: any) {
    const transport = this.getTransport(socket);
    // console.log("DTLS PARAMS... ", { dtlsParameters: data.dtlsParameters });
    await transport.connect({
      dtlsParameters: data.dtlsParameters,
    });

    return { id: transport.id };
  }

  async transportProduce(socket: Socket, data: any) {
    // call produce based on the prameters from the client
    const producer = await this.getTransport(socket).produce({
      kind: data.kind,
      rtpParameters: data.rtpParameters,
    });

    // add producer to the producers array
    const { roomName } = this.peers[socket.id];

    this.addProducer(socket, producer, roomName);

    this.informConsumers(roomName, socket.id, producer.id);

    // console.log("Producer ID: ", producer.id, producer.kind);

    producer.on("transportclose", () => {
      // console.log("transport for this producer closed ");
      producer.close();
    });

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    producer.addListener("audioLevel", (level) => {
      console.log("audioLevel", level);

      // console.log("transport for this producer closed ");
    });

    // Send back to the client the Producer's id
    return {
      id: producer.id,
      producersExist: this.producers.length > 1 ? true : false,
    };
  }

  // see client's socket.emit('transport-recv-connect', ...)
  async transportRecvConnect(socket: Socket, data: any) {
    // console.log(`DTLS PARAMS: ${data.dtlsParameters}`);
    const consumerTransport = this.transports.filter(
      (transportData) =>
        transportData.consumer &&
        transportData.transport.id == data.serverConsumerTransportId
    )[0].transport;

    await consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
  }

  async consume(socket: Socket, data: any) {
    try {
      const { roomName } = this.peers[socket.id];
      const router = this.rooms[roomName].router;
      const _consumerTransport = this.transports.filter(
        (transportData) =>
          transportData.consumer &&
          transportData.transport.id == data.serverConsumerTransportId
      )[0];
      const consumerTransport = _consumerTransport.transport;

      const { socketId } = this.producers.filter(
        (p) => p.producer.id == data.remoteProducerId
      )[0];

      const { peerDetails } = this.peers[socketId];

      // check if the router can consume the specified producer
      if (
        router.canConsume({
          producerId: data.remoteProducerId,
          rtpCapabilities: data.rtpCapabilities,
        })
      ) {
        // transport can now consume and return a consumer
        const consumer = await consumerTransport.consume({
          producerId: data.remoteProducerId,
          rtpCapabilities: data.rtpCapabilities,
          paused: true,
        });

        consumer.on("transportclose", () => {
          console.log("transport close from consumer");
        });

        consumer.on("producerclose", () => {
          console.log("producer of consumer closed");
          socket.emit("producer-closed", {
            remoteProducerId: data.remoteProducerId,
          });

          // consumerTransport.close([]);
          consumerTransport.close();
          this.transports = this.transports.filter(
            (transportData) =>
              transportData.transport.id !== consumerTransport.id
          );
          consumer.close();
          this.consumers = this.consumers.filter(
            (consumerData) => consumerData.consumer.id !== consumer.id
          );
        });

        this.addConsumer(socket, consumer, roomName);

        // from the consumer extract the following params
        // to send back to the Client
        const params = {
          id: consumer.id,
          producerId: data.remoteProducerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          serverConsumerId: consumer.id,
          peerDetails,
        };

        // send the parameters to the client
        return { params };
      }
    } catch (error) {
      console.log(error);
      return { params: { error: error } };
    }
  }

  async consumerResume(socket: Socket, data: any) {
    const { consumer } = this.consumers.filter(
      (consumerData) => consumerData.consumer.id === data.serverConsumerId
    )[0];

    await consumer.resume();

    return { paused: consumer.paused, producerPaused: consumer.producerPaused };
  }

  async producerSwitch(socket: Socket, data: any) {
    const peer = this.peers[socket.id];
    if (!peer) throw "peer not found";

    const { roomName, peerDetails } = peer;

    const { producer } = this.producers.filter(
      (producer) => producer.producer.id === data.producerId
    )[0];

    if (producer.paused) await producer.resume();
    else await producer.pause();

    this.server.to(roomName).emit("producer-switch", {
      paused: producer.paused,
      kind: producer.kind,
      peerDetails,
    });

    return { paused: producer.paused };
  }
}
