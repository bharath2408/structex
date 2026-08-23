import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * WebSocket gateways.
 *
 * A separate, optional subsystem from the HTTP controller layer — it does
 * not share metadata with `@Controller`, and this module is not re-exported
 * from the package root. `ws` is a peer dependency, installed only if you
 * import from here, so everyone who doesn't use WebSockets pays nothing for
 * this file existing.
 *
 * Wire format: JSON `{ event, data }` in both directions. A handler's return
 * value (if not `undefined`) is sent back as `{ event, data: <return> }`.
 */

interface WsParamDefinition {
  index: number;
  type: "socket" | "body" | "request";
}

interface GatewayMeta {
  path: string;
  /** event name -> handler method name */
  handlers: Map<string, string>;
  /** handler method name -> parameter definitions */
  params: Map<string, WsParamDefinition[]>;
}

const store = new WeakMap<Function, GatewayMeta>();

function getMeta(target: Function): GatewayMeta {
  let meta = store.get(target);
  if (!meta) {
    meta = { path: "/", handlers: new Map(), params: new Map() };
    store.set(target, meta);
  }
  return meta;
}

/** Marks a class as a WebSocket gateway, mounted at `path` on the HTTP server. */
export function WebSocketGateway(path = "/"): ClassDecorator {
  return (target) => {
    getMeta(target as unknown as Function).path = path;
  };
}

/**
 * Routes incoming `{ event, data }` messages matching `event` to this method.
 *
 * ```ts
 * @WebSocketGateway("/ws/chat")
 * class ChatGateway {
 *   @SubscribeMessage("message")
 *   onMessage(@MessageBody() text: string) {
 *     return { echo: text };
 *   }
 * }
 * ```
 */
export function SubscribeMessage(event: string): MethodDecorator {
  return (target, propertyKey) => {
    getMeta(target.constructor as Function).handlers.set(
      event,
      String(propertyKey),
    );
  };
}

function addParam(
  target: object,
  propertyKey: string | symbol | undefined,
  index: number,
  type: WsParamDefinition["type"],
): void {
  if (propertyKey === undefined) return;
  const meta = getMeta((target as { constructor: Function }).constructor);
  const name = String(propertyKey);
  const list = meta.params.get(name) ?? [];
  list.push({ index, type });
  meta.params.set(name, list);
}

/** Injects the parsed `data` field of the incoming message. */
export function MessageBody(): ParameterDecorator {
  return (target, propertyKey, index) => addParam(target, propertyKey, index, "body");
}

/** Injects the raw `ws` socket for this connection. */
export function ConnectedSocket(): ParameterDecorator {
  return (target, propertyKey, index) =>
    addParam(target, propertyKey, index, "socket");
}

/** Injects the upgrade `IncomingMessage`, e.g. to read headers or query params. */
export function ConnectionRequest(): ParameterDecorator {
  return (target, propertyKey, index) =>
    addParam(target, propertyKey, index, "request");
}

export interface WsApplicationOptions {
  /**
   * Called when a handler throws or a message fails to parse. Defaults to
   * sending an `{ event: "error", data: { message } }` frame back.
   */
  onError?: (err: unknown, socket: WebSocket) => void;
}

export interface WsApplicationRef {
  /** Closes every gateway's server and terminates open connections. */
  close(): Promise<void>;
}

function defaultOnError(err: unknown, socket: WebSocket): void {
  const message = err instanceof Error ? err.message : "Internal error";
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({ event: "error", data: { message } }));
  }
}

/**
 * Attaches every gateway's `WebSocketServer` to `server`, one per declared
 * `path` — `ws` routes upgrade requests to whichever server's path matches,
 * so multiple gateways can share one HTTP server.
 *
 * Gateways are plain instances, like `registerControllers` — resolve them
 * from your DI container yourself first if they need injected dependencies.
 *
 * ```ts
 * const httpServer = app.listen(3000);
 * const ws = createWsApplication(httpServer, [new ChatGateway()]);
 * ```
 */
export function createWsApplication(
  server: HttpServer,
  gateways: object[],
  options: WsApplicationOptions = {},
): WsApplicationRef {
  const onError = options.onError ?? defaultOnError;
  const servers: WebSocketServer[] = [];
  // path -> its server, for manual upgrade routing below.
  const byPath = new Map<string, WebSocketServer>();

  for (const gateway of gateways) {
    const meta = store.get(gateway.constructor);
    if (!meta) continue; // not a decorated gateway

    // `noServer: true` — each gateway must NOT attach its own listener to
    // `server`. ws's built-in `{ server, path }` wiring gives every instance
    // an unconditional 'upgrade' listener that aborts (400) any request that
    // doesn't match *its own* path — including ones another gateway already
    // accepted, corrupting that connection. One shared listener below routes
    // by path and calls exactly one gateway's handleUpgrade().
    const wss = new WebSocketServer({ noServer: true });
    servers.push(wss);
    byPath.set(meta.path, wss);

    wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
      socket.on("message", (raw: { toString(): string }) => {
        void (async () => {
          let event: string | undefined;
          let data: unknown;
          try {
            const parsed = JSON.parse(raw.toString()) as {
              event?: string;
              data?: unknown;
            };
            event = parsed.event;
            data = parsed.data;
          } catch {
            onError(new Error("Invalid JSON message"), socket);
            return;
          }

          const handlerName = event !== undefined ? meta.handlers.get(event) : undefined;
          if (!handlerName) {
            onError(new Error(`Unknown event: ${JSON.stringify(event)}`), socket);
            return;
          }

          try {
            const params = meta.params.get(handlerName) ?? [];
            const args: unknown[] = new Array(
              params.length ? Math.max(...params.map((p) => p.index)) + 1 : 0,
            );
            for (const param of params) {
              args[param.index] =
                param.type === "socket" ? socket : param.type === "request" ? req : data;
            }

            const result = await (gateway as Record<string, Function>)[handlerName]!(
              ...args,
            );
            if (result !== undefined && socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({ event, data: result }));
            }
          } catch (err) {
            onError(err, socket);
          }
        })();
      });
    });
  }

  const onUpgrade = (
    req: IncomingMessage,
    socket: import("node:net").Socket,
    head: Buffer,
  ): void => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const wss = byPath.get(pathname);
    if (!wss) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };
  server.on("upgrade", onUpgrade);

  return {
    close: () => {
      server.off("upgrade", onUpgrade);
      return Promise.all(
        servers.map(
          (wss) =>
            new Promise<void>((resolve, reject) => {
              for (const client of wss.clients) client.terminate();
              wss.close((err) => (err ? reject(err) : resolve()));
            }),
        ),
      ).then(() => undefined);
    },
  };
}
