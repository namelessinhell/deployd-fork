// Minimal TypeScript declarations for the deployd package to ease integration
// in TypeScript and ESM/CJS mixed projects.

declare namespace deployd {
  interface Credentials {
    username: string;
    password: string;
  }

  interface DbOptions {
    port?: number;
    host?: string;
    name?: string;
    connectionString?: string;
    credentials?: Credentials;
    connectionOptions?: Record<string, unknown>;
  }

  interface SocketIoOptions {
    cors?: any;
    adapter?: any;
    options?: Record<string, unknown>;
  }

  interface Options {
    port?: number;
    host?: string;
    db?: DbOptions;
    socketIo?: SocketIoOptions;
    env?: string;
    sessions?: Record<string, unknown>;
    server_dir?: string;
    origins?: string[];
    allowedResponseHeaders?: string[];
    allowedRequestHeaders?: string[];
    allowCorsRootRequests?: boolean;
  }

  interface Server {
    options: Options;
    listen(port?: number, host?: string): this;
    route(req: any, res: any): void | Promise<void>;
    shutdown(): void | Promise<void>;
    // Expose minimal fields used by consumers without tightly coupling
    db?: any;
    io?: any;
  }

  function attach(server: any): any;
}

declare function deployd(config?: deployd.Options): deployd.Server;

export = deployd;

