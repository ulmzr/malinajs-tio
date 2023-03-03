const { existsSync, readFileSync, watch } = require("node:fs");
const { join } = require("node:path");

const DEV = process.argv.includes("--watch") || false;
const PROD = process.argv.includes("--prod") || false;
const BUILD = process.argv.includes("--build") || false;

if (DEV || PROD || BUILD) {
   //
   const cwd = process.cwd();
   const configPath = join(cwd, "tio.config.js");
   const config = existsSync(configPath) ? require(configPath) : {};
   //

   const publicDir = config.publicDir || "public";
   const fastifyConfig = config.fastify || {};
   const foptions = fastifyConfig.options || {};
   const plugins = fastifyConfig.plugins || "plugins";
   const routes = fastifyConfig.plugins || "routes";
   const esbuildConfig = config.esbuild || {};
   const https = foptions.https || false;

   const host = config.host || "localhost";
   const port = config.port || 3000;
   const wsPort = 35729;
   const httpPort = config.httpPort || 80;

   var ctx, socket;

   // Redirect http to https
   if (https)
      require("http")
         .createServer((req, res) => {
            const {
               headers: { host },
               url,
            } = req;
            if (host) {
               const redirectUrl = `https://${host}:443${url}`;
               res.writeHead(301, {
                  Location: redirectUrl,
               });
               res.end();
            }
         })
         .listen(httpPort);

   // Initiate fastify
   const fastify = require("fastify")(foptions);

   // Add spa handler
   fastify.addHook("onRequest", async (request, reply) => {
      var source = "",
         fromUrl = "",
         url = request.url.replace(/[\#\?].*$/, ""),
         mime = mimeType(url);

      if (url.includes("/api")) return;

      if (DEV && url.includes("/lrscript.js")) {
         reply.header("Content-Type", "text/javascript").send(injectedScript());
         return;
      }

      if (!mime) {
         fromUrl = url;
         url = "/index.html";
         mime = mimeType().default;
      }

      var filename = join(publicDir, url);
      var code = existsSync(filename) ? "200" : 404;

      if (code === "200")
         if (DEV) source = readFileSync(filename, "utf8");
         else source = await readFile(filename, "utf8");

      if (DEV && url.endsWith("index.html"))
         source = source.replace(
            "</head>",
            `<script src="/lrscript.js"></script></head>`
         );

      console.log(code, `☛`, url, fromUrl ? `☚ redirect ${fromUrl}` : ``);

      reply.code(code).header("Content-type", mime).send(Buffer.from(source));
   });

   // Load plugins
   fastify.register(require("@fastify/autoload"), {
      dir: join(__dirname, plugins),
   });

   // Load routes
   fastify.register(require("@fastify/autoload"), {
      dir: join(__dirname, routes),
      options: {
         prefix: "/api",
      },
   });

   const compile = async () => {
      try {
         // Compile & bundle script
         const esbuild = require("esbuild");
         ctx = await esbuild.context({
            entryPoints: [`src/index.js`],
            minify: BUILD ? true : false,
            bundle: true,
            format: "esm",
            outdir: "public",
            plugins: [malinaPlugin()],
            ...esbuildConfig,
         });

         await ctx.watch();

         if (BUILD) await ctx.dispose();
      } catch (error) {
         console.log(error);
      }
   };

   compile();

   // Start fastify server
   const startServer = async () => {
      try {
         await fastify.listen({ host, port });
         console.log(
            `Server run on http${!https ? `` : `s`}://${host}${
               port == 443 ? `` : `:${port}`
            }\n`
         );
      } catch (err) {
         fastify.log.error(err);
         process.exit(1);
      }
   };

   if (DEV || PROD) startServer();

   // Do not watch if in production;
   if (DEV) {
      const { WebSocketServer } = require("ws");
      const chokidar = require("chokidar");

      // Start websocket
      new WebSocketServer({ port: wsPort }).on(
         "connection",
         (ws) => (socket = ws)
      );

      // Start watching

      chokidar
         .watch([routes, plugins], {
            ignored: /(^|[\/\\])\../,
            persistent: true,
            cwd: __dirname,
         })
         .on("change", function () {
            console.log("Reload Server...");
            process.exit();
         });

      var hot;

      const _src = chokidar.watch(["src"], {
         ignored: /(^|[\/\\])\../,
         persistent: true,
         cwd: __dirname,
      });

      _src.on("change", async (path) => {
         if (!socket) return;
         hot = false;
         path = path.replace(/(\\\\|\\)/g, "/");
         if (path.match(/^.*\.(scss|css)$/)) {
            hot = true;
            await ctx.rebuild();
         }
      });

      const _public = chokidar.watch([publicDir], {
         ignored: /(^|[\/\\])\../,
         persistent: true,
         cwd: __dirname,
      });

      _public.on("change", (path) => {
         if (!socket) return;
         path = path.replace(/(\\\\|\\)/g, "/");
         if (path.match(/^.*\.(scss|css)$/)) hot = true;
         else hot = false;
         socket.send(
            JSON.stringify({
               hot,
               change: path.replace(publicDir, ""),
            })
         );
         !hot && console.log("\nLive reload...!\n");
      });
   }
} else {
   const proc = () => {
      require("child_process")
         .spawn("node", [__dirname + "\\index.js", "--", `--watch`], {
            stdio: ["ignore", "inherit", "inherit"],
            shell: true,
         })
         .on("close", proc);
   };
   proc();
}

function mimeType(uri) {
   const map = {
      default: "text/html, charset=UTF-8",
      ".ico": "image/x-icon",
      ".html": "text/html, charset=UTF-8",
      ".js": "text/javascript",
      ".json": "application/json",
      ".css": "text/css",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".webp": "image/webp",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".doc": "application/msword",
   };
   if (uri) return map[uri.match(/\.([0-9a-z]+)(?=[?#])|(\.)(?:[\w]+)$/gim)];
   else return map;
}

const readFile = (filename, encoding) => {
   return new Promise((resolve, reject) => {
      resolve(readFileSync(filename, encoding));
   });
};

function malinaPlugin(options = {}) {
   const malina = require("malinajs");

   if (options.displayVersion !== false)
      console.log("\nMalinaJS ", malina.version);
   const cssModules = new Map();
   return {
      name: "malina-plugin",
      setup(build) {
         build.onLoad({ filter: /\.(xht|ma)$/ }, async (args) => {
            try {
               let source = await readFile(args.path, "utf8");
               let ctx = await malina.compile(source, {
                  path: args.path,
                  name: args.path.match(/([^/\\]+)\.\w+$/)[1],
                  ...options,
               });

               let code = ctx.result;

               if (ctx.css.result) {
                  const cssPath = args.path
                     .replace(/\.\w+$/, ".malina.css")
                     .replace(/\\/g, "/");
                  cssModules.set(cssPath, ctx.css.result);
                  code += `\nimport "${cssPath}";`;
               }
               return { contents: code };
            } catch (error) {
               console.log(error);
               return {};
            }
         });

         build.onResolve({ filter: /\.malina\.css$/ }, ({ path }) => {
            return { path, namespace: "malinacss" };
         });

         build.onLoad(
            { filter: /\.malina\.css$/, namespace: "malinacss" },
            ({ path }) => {
               const css = cssModules.get(path);
               return css ? { contents: css, loader: "css" } : null;
            }
         );
      },
   };
}

function injectedScript() {
   return `
const url = "ws://localhost:35729"
var s = new WebSocket(url)
s.onclose =_=> {
   const run =_=> {
      s = new WebSocket(url)
      s.onerror =_=> setTimeout(run, 2000)
      s.onopen =_=> location.reload()
   };
   run()
}
s.onmessage = e => {
   const updated = JSON.parse(e.data)
   if(!updated.hot)location.reload()
   const link = document.querySelector('link[href*="' + updated.change + '"]')
   if(!link) return 
   const url = new URL(link.href)
   const next = link.cloneNode()
   next.onload =_=> link.remove()
   next.href = url.pathname + "?" + Math.random().toString(16).substr(-6)
   link.parentNode.insertBefore(next, link.nextSibling)
}`;
}
