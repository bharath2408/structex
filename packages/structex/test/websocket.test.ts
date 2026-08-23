import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  ConnectedSocket,
  ConnectionRequest,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  createWsApplication,
  type WsApplicationRef,
} from "../src/websocket.js";

let server: Server | undefined;
let wsApp: WsApplicationRef | undefined;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

afterEach(async () => {
  await wsApp?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  wsApp = undefined;
});

function send(socket: WebSocket, event: string, data?: unknown): void {
  socket.send(JSON.stringify({ event, data }));
}

function nextMessage(socket: WebSocket): Promise<{ event?: string; data?: unknown }> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => {
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (err) {
        reject(err);
      }
    });
    socket.once("error", reject);
  });
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("WebSocket gateways", () => {
  it("routes a message to the matching @SubscribeMessage handler and returns its result", async () => {
    @WebSocketGateway("/ws")
    class EchoGateway {
      @SubscribeMessage("echo")
      echo(@MessageBody() text: string) {
        return { text, shouted: text.toUpperCase() };
      }
    }

    server = createServer();
    const port = await listen(server);
    wsApp = createWsApplication(server, [new EchoGateway()]);

    const socket = await connect(`ws://localhost:${port}/ws`);
    send(socket, "echo", "hello");
    const reply = await nextMessage(socket);

    expect(reply).toEqual({
      event: "echo",
      data: { text: "hello", shouted: "HELLO" },
    });
    socket.close();
  });

  it("injects the raw socket via @ConnectedSocket", async () => {
    @WebSocketGateway("/ws")
    class DirectGateway {
      @SubscribeMessage("ping")
      ping(@ConnectedSocket() socket: WebSocket) {
        socket.send(JSON.stringify({ event: "pong", data: null }));
        // No return value — the handler replied itself, so nothing auto-sent.
      }
    }

    server = createServer();
    const port = await listen(server);
    wsApp = createWsApplication(server, [new DirectGateway()]);

    const socket = await connect(`ws://localhost:${port}/ws`);
    send(socket, "ping");
    const reply = await nextMessage(socket);

    expect(reply).toEqual({ event: "pong", data: null });
    socket.close();
  });

  it("injects the upgrade request via @ConnectionRequest", async () => {
    @WebSocketGateway("/ws")
    class HeaderGateway {
      @SubscribeMessage("whoami")
      whoami(@ConnectionRequest() req: { headers: Record<string, unknown> }) {
        return { userAgent: req.headers["user-agent"] ?? null };
      }
    }

    server = createServer();
    const port = await listen(server);
    wsApp = createWsApplication(server, [new HeaderGateway()]);

    const socket = await connect(`ws://localhost:${port}/ws`);
    send(socket, "whoami");
    const reply = await nextMessage(socket);

    expect((reply.data as { userAgent: unknown }).userAgent).toBeDefined();
    socket.close();
  });

  it("sends an error frame for an unregistered event", async () => {
    @WebSocketGateway("/ws")
    class NarrowGateway {
      @SubscribeMessage("known")
      known() {
        return { ok: true };
      }
    }

    server = createServer();
    const port = await listen(server);
    wsApp = createWsApplication(server, [new NarrowGateway()]);

    const socket = await connect(`ws://localhost:${port}/ws`);
    send(socket, "unknown-event");
    const reply = await nextMessage(socket);

    expect(reply.event).toBe("error");
    expect((reply.data as { message: string }).message).toContain("unknown-event");
    socket.close();
  });

  it("sends an error frame for invalid JSON instead of crashing the connection", async () => {
    @WebSocketGateway("/ws")
    class AnyGateway {
      @SubscribeMessage("x")
      x() {
        return { ok: true };
      }
    }

    server = createServer();
    const port = await listen(server);
    wsApp = createWsApplication(server, [new AnyGateway()]);

    const socket = await connect(`ws://localhost:${port}/ws`);
    const replyPromise = nextMessage(socket);
    socket.send("not json{{{");
    const reply = await replyPromise;

    expect(reply.event).toBe("error");

    // The connection survives — a follow-up valid message still works.
    const secondReply = nextMessage(socket);
    send(socket, "x");
    expect(await secondReply).toEqual({ event: "x", data: { ok: true } });
    socket.close();
  });

  it("catches a handler throwing and reports it as an error frame", async () => {
    @WebSocketGateway("/ws")
    class ThrowingGateway {
      @SubscribeMessage("boom")
      boom() {
        throw new Error("kaboom");
      }
    }

    server = createServer();
    const port = await listen(server);
    wsApp = createWsApplication(server, [new ThrowingGateway()]);

    const socket = await connect(`ws://localhost:${port}/ws`);
    send(socket, "boom");
    const reply = await nextMessage(socket);

    expect(reply.event).toBe("error");
    expect((reply.data as { message: string }).message).toBe("kaboom");
    socket.close();
  });

  it("routes multiple gateways at different paths independently", async () => {
    @WebSocketGateway("/ws/a")
    class GatewayA {
      @SubscribeMessage("which")
      which() {
        return "a";
      }
    }
    @WebSocketGateway("/ws/b")
    class GatewayB {
      @SubscribeMessage("which")
      which() {
        return "b";
      }
    }

    server = createServer();
    const port = await listen(server);
    wsApp = createWsApplication(server, [new GatewayA(), new GatewayB()]);

    const socketA = await connect(`ws://localhost:${port}/ws/a`);
    const socketB = await connect(`ws://localhost:${port}/ws/b`);

    send(socketA, "which");
    send(socketB, "which");

    expect((await nextMessage(socketA)).data).toBe("a");
    expect((await nextMessage(socketB)).data).toBe("b");

    socketA.close();
    socketB.close();
  });
});
