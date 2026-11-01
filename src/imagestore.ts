import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { AppConfig } from "./config.ts";
import { Database } from "./db/index.ts";
import { storedImages } from "./db/schema.ts";
import type { ImageType } from "./expressions/image.ts";

// Images the bot makes for embeds to link to, like shinpuru's image store:
// kept in the database and served by the web interface at
// `/imagestore/<id>.<ext>`. Without a web interface there's nowhere to serve
// them from, so nothing is stored.

/** The path images are served under. */
export const IMAGE_STORE_PATH = "/imagestore";

/** `<id>.<ext>`, the last part of an image's URL. */
const FILE = /^([\w-]+)\.\w+$/;

export class ImageStore extends Context.Service<
  ImageStore,
  {
    /** Stores an image and returns its public URL; null without a web interface. */
    readonly put: (image: Uint8Array, type: ImageType) => Effect.Effect<string | null>;
    /** The image for the last part of its URL, `<id>.<ext>`. */
    readonly get: (file: string) => Effect.Effect<{ image: Uint8Array; contentType: string } | undefined>;
    /** Deletes the image at `url`. Anything that isn't a stored image's URL is left alone. */
    readonly remove: (url: string) => Effect.Effect<void>;
  }
>()("orianna/ImageStore") {
  static readonly layer = Layer.effect(
    ImageStore,
    Effect.gen(function* () {
      const db = yield* Database;
      const { web } = yield* AppConfig.current;
      const base = web && `${web.publicUrl}${IMAGE_STORE_PATH}/`;
      const idOf = (file: string) => FILE.exec(file)?.[1];

      return {
        put: (image, type) =>
          Effect.sync(() => {
            if (!base) return null;
            const id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
            db.insert(storedImages)
              .values({ id, image: Buffer.from(image), contentType: type.mime, storedAt: new Date() })
              .run();
            return `${base}${id}.${type.ext}`;
          }),

        get: (file) =>
          Effect.sync(() => {
            const id = idOf(file);
            if (!id) return undefined;
            return db
              .select({ image: storedImages.image, contentType: storedImages.contentType })
              .from(storedImages)
              .where(eq(storedImages.id, id))
              .get();
          }),

        // By the path alone, so images from before `publicUrl` changed go too.
        remove: (url) =>
          Effect.sync(() => {
            const path = URL.parse(url)?.pathname ?? "";
            const prefix = `${IMAGE_STORE_PATH}/`;
            const id = path.startsWith(prefix) ? idOf(path.slice(prefix.length)) : undefined;
            if (id) db.delete(storedImages).where(eq(storedImages.id, id)).run();
          }),
      };
    }),
  );
}
