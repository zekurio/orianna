// Bun's bundler turns an imported image into the URL it serves it at.
declare module "*.png" {
  const url: string;
  export default url;
}
