// The compiled bot serves the app's files itself instead of handing a bundle
// to Bun, which would send them uncompressed and without telling browsers to
// keep them. The script alone is about 700 KB, a quarter of that compressed,
// which matters on a phone. scripts/build.ts builds the files, compresses
// them and puts them inside the executable, with a list of them for here.
// Every file but the page has a hash in its name, so browsers keep it for
// good and only ask for the page again, which changes with each build.

/** Best first. Brotli is smallest; browsers only ask for it over HTTPS. */
export type Encoding = "br" | "gzip";

/** A file of the built app, as scripts/build.ts lists it. */
export interface WebFile {
  readonly name: string;
  readonly type: string;
  /** Changes with the file. */
  readonly etag: string;
  /** The compressed copies there are, as `<name>.<encoding>`. */
  readonly encodings: readonly Encoding[];
}

interface AppRoutes {
  readonly files: Record<string, (req: Request) => Response>;
  /** The app, for every page. */
  readonly page: (req: Request) => Response;
}

/** Routes for the files scripts/build.ts lists, and one that answers every other page with the app. */
export function appRoutes(list: readonly WebFile[]): AppRoutes {
  // Where the compiled bot keeps them, next to the migrations; see src/db/index.ts.
  const dir = `${import.meta.dir}/web`;
  const files: AppRoutes["files"] = {};
  let page: AppRoutes["page"] | undefined;
  for (const file of list) {
    const isPage = file.name === "index.html";
    // The page is asked for on every visit, and answered with 304 while it's the same.
    const route = respond(dir, file, isPage ? "no-cache" : "public, max-age=31536000, immutable");
    if (isPage) page = route;
    else files[`/${file.name}`] = route;
  }
  if (!page) throw new Error("the build left out the web interface's page");
  return { files, page };
}

function respond(dir: string, file: WebFile, cacheControl: string): (req: Request) => Response {
  const headers: Record<string, string> = {
    "Content-Type": file.type,
    // Weak, since the bytes differ with the encoding.
    ETag: `W/"${file.etag}"`,
    "Cache-Control": cacheControl,
    ...(file.encodings.length ? { Vary: "Accept-Encoding" } : {}),
  };
  return (req) => {
    if (req.headers.get("if-none-match") === headers.ETag) return new Response(null, { status: 304, headers });
    const accepted = req.headers.get("accept-encoding") ?? "";
    const encoding = file.encodings.find((e) => accepted.includes(e));
    // Read from the executable, rather than kept a second time in memory.
    if (!encoding) return new Response(Bun.file(`${dir}/${file.name}`), { headers });
    return new Response(Bun.file(`${dir}/${file.name}.${encoding}`), {
      headers: { ...headers, "Content-Encoding": encoding },
    });
  };
}
