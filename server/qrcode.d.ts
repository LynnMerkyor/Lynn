declare module "qrcode" {
  const QRCode: {
    toDataURL(text: string, options?: { width?: number; margin?: number }): Promise<string>;
  };
  export default QRCode;
}
