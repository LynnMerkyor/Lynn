declare module 'pngjs' {
  import type { Buffer } from 'node:buffer';

  export class PNG {
    static sync: {
      read(buffer: Buffer): PNG;
      write(image: PNG): Buffer;
    };

    width: number;
    height: number;
    data: Buffer;

    constructor(options: { width: number; height: number });
  }
}
