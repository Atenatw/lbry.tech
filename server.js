"use strict"; require("dotenv").config(); require("date-format-lite");



//  P A C K A G E S

const async = require("async");
const color = require("turbocolor");
const cors = require("cors");
const dedent = require("dedent");

const fastify = require("fastify")({
  logger: {
    level: "warn",
    prettyPrint: process.env.NODE_ENV === "development" ? true : false
  }
});

const html = require("choo-async/html");
const local = require("app-root-path").require;
const octokit = require("@octokit/rest")();
const redis = require("redis");
const request = require("request-promise-native");
const stringifyObject = require("stringify-object");

//  V A R I A B L E S

const github = local("/helpers/github");
const log = console.log; // eslint-disable-line
const logSlackError = local("/helpers/slack");
const relativeDate = local("/modules/relative-date");
let client;

if (typeof process.env.GITHUB_OAUTH_TOKEN !== "undefined") {
  octokit.authenticate({
    type: "oauth",
    token: process.env.GITHUB_OAUTH_TOKEN
  });
} else log(`${color.red("[missing]")} GitHub token`);

if (typeof process.env.REDISCLOUD_URL !== "undefined") {
  client = redis.createClient(process.env.REDISCLOUD_URL);

  client.on("error", redisError => {
    process.env.NODE_ENV === "development" ?
      log(`\n${color.yellow("Unable to connect to Redis client.")}\nYou may be missing an .env file or your connection was reset.`) :
      logSlackError(
        "\n" +
        "> *REDIS ERROR:* ```" + JSON.parse(JSON.stringify(redisError)) + "```" + "\n" +
        "> _Cause: Someone is trying to run LBRY.tech locally without environment variables OR Heroku is busted_\n"
      )
    ;
  });
} else log(`${color.red("[missing]")} Redis client URL`);



//  P R O G R A M

fastify.use(cors());

fastify.register(require("fastify-compress"));
fastify.register(require("fastify-ws"));

fastify.register(require("fastify-helmet"), {
  hidePoweredBy: { setTo: "LBRY" }
});

fastify.register(require("fastify-static"), {
  root: `${__dirname}/public/`,
  prefix: "/assets/"
});

fastify.register(require("choo-ssr/fastify"), {
  app: require("./client"),
  plugins: [
    [ require("choo-bundles/ssr"), {} ]
  ]
});

fastify.ready(err => {
  if (err) throw err;

  fastify.ws.on("connection", socket => {
    socket.on("message", data => {
      data = JSON.parse(data);

      switch(data.message) {
        case "fetch metadata":
          fetchMetadata(data, socket);
          break;

        case "landed on homepage":
          generateGitHubFeed(result => {
            socket.send(JSON.stringify({
              "html": result,
              "message": "updated html",
              "selector": "#github-feed"
            }));
          });

          break;

        case "subscribe":
          newsletterSubscribe(data, socket);
          break;

        default:
          log(data);
          break;
      }
    });

    socket.on("close", () => socket.terminate());
  });
});



//  B E G I N

const start = async () => {
  try {
    await fastify.listen(process.env.PORT || 8080, process.env.IP || "0.0.0.0");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  process.env.NODE_ENV === "development" ?
    log(`\n— ${color.green("⚡")} ${fastify.server.address().port}\n`) :
    logSlackError(`Server started at port \`${fastify.server.address().port}\``)
  ;
};

start();



//  H E L P E R S

function fetchMetadata(data, socket) {
  let dataDetails = "";

  if (data.step === 1 && !data.claim || !data.method) return;
  if (data.step === 2 && !data.data) return;
  if (data.step === 2) dataDetails = data.data;

  const claimAddress = data.claim;
  const resolveMethod = data.method;

  const allowedClaims = [
    "fortnite-top-stream-moments-nickatnyte",
    "hellolbry",
    "itsadisaster",
    "six",
    "unbubbled1-1"
  ];

  const allowedMethods = [
    "publish",
    "resolve",
    "wallet_send"
  ];

  if (allowedMethods.indexOf(resolveMethod) < 0) return socket.send(JSON.stringify({
    "details": "Unallowed resolve method for tutorial",
    "message": "notification",
    "type": "error"
  }));

  if (data.step === 1 && allowedClaims.indexOf(claimAddress) < 0) return socket.send(JSON.stringify({
    "details": "Invalid claim ID for tutorial",
    "message": "notification",
    "type": "error"
  }));

  const body = {};

  body.access_token = process.env.LBRY_DAEMON_ACCESS_TOKEN;
  body.method = resolveMethod;
  if (data.step === 1) body.uri = claimAddress;

  if (resolveMethod === "publish") {
    body.bid = 0.001; // Hardcoded publish amount
    body.description = dataDetails.description;
    body.file_path = process.env.LBRY_DAEMON_IMAGES_PATH + dataDetails.file_path; // TODO: Fix the internal image path in daemon (original comment, check to see if still true)
    body.language = dataDetails.language;
    body.license = dataDetails.license;
    body.name = dataDetails.name;
    body.nsfw = dataDetails.nsfw;
    body.title = dataDetails.title;

    return uploadImage(body.file_path).then(uploadResponse => {
      if (uploadResponse.status !== "ok") return;

      body.file_path = uploadResponse.filename;
      body.method = resolveMethod;

      // Reference:
      // https://github.com/lbryio/lbry.tech/blob/master/content/.vuepress/components/Tour/Step2.vue
      // https://github.com/lbryio/lbry.tech/blob/master/server.js

      return new Promise((resolve, reject) => {
        request({
          qs: body,
          url: "http://daemon.lbry.tech/images.php"
        }, (error, response, body) => {
          if (error) reject(error);
          body = JSON.parse(body);
          // console.log(body);
          resolve(body);
        });
      });
    }).catch(uploadError => {
      // component.isLoading = false;
      // component.jsonData = JSON.stringify(uploadError, null, "  ");

      socket.send(JSON.stringify({
        "details": "Image upload failed",
        "message": "notification",
        "type": "error"
      }));

      logSlackError(
        "\n" +
        "> *DAEMON ERROR:* ```" + JSON.parse(JSON.stringify(uploadError)) + "```" + "\n" +
        "> _Cause: Someone attempted to publish a meme via the Tour_\n"
      );

      return;
    });
  }

  return new Promise((resolve, reject) => { // eslint-disable-line
    request({
      url: "http://daemon.lbry.tech",
      qs: body
    }, (error, response, body) => {
      if (error) {
        logSlackError(
          "\n" +
          "> *DAEMON ERROR:* ```" + JSON.parse(JSON.stringify(error)) + "```" + "\n" +
          "> _Cause: Someone is going through the Tour_\n"
        );

        return resolve(error);
      }

      body = JSON.parse(body);

      if (typeof body.error !== "undefined") {
        logSlackError(
          "\n" +
          "> *DAEMON ERROR:* ```" + JSON.parse(JSON.stringify(body.error)) + "```" + "\n" +
          "> _Cause: Someone is going through the Tour_\n"
        );

        return resolve(body.error);
      }

      socket.send(JSON.stringify({
        "html": html`
          <p style="text-align: center;">Success! Here is the response for <strong>lbry://${claimAddress}</strong>:</p>
          <pre><code class="json">${stringifyObject(body, { indent: "  ", singleQuotes: false })}</code></pre>
          <button class="__button-black" data-action="tour, step 2" type="button">Go to next step</button>
          <script>$('#temp-loader').remove();</script>
        `,
        "message": "updated html",
        "selector": "#step1-result"
      }));
    });
  });
}

function generateGitHubFeed(displayGitHubFeed) {
  if (typeof process.env.REDISCLOUD_URL !== "undefined") {
    client.zrevrange("events", 0, 9, (err, reply) => {
      if (err) return; // TODO: Render a div with nice error message

      const events = [];
      const renderedEvents = [];

      reply.forEach(item => events.push(JSON.parse(item)));

      for (const event of events) {
        renderedEvents.push(`
          <div class='github-feed__event'>
            <a href="${github.generateUrl("actor", event)}" target="_blank" rel="noopener noreferrer">
              <img src="${event.actor.avatar_url}" class="github-feed__event__avatar" alt=""/>
            </a>

            <p>
              ${github.generateEvent(event)}
              <a href="${github.generateUrl("repo", event)}" title="View this repo on GitHub" target="_blank" rel="noopener noreferrer"><strong>${event.repo.name}</strong></a>
              <em class="github-feed__event__time">${relativeDate(new Date(event.created_at))}</em>
            </p>
          </div>
        `);
      }

      updateGithubFeed(); // TODO: Update `.last-updated` every minute

      displayGitHubFeed(dedent`
        <h3>GitHub</h3>
        <h5 class="last-updated">Last updated: ${new Date().format("YYYY-MM-DD").replace(/-/g, "&middot;")} at ${new Date().add(-4, "hours").format("UTC:H:mm:ss A").toLowerCase()} EST</h5>

        ${renderedEvents.join("")}
      `);
    });
  }
}

function newsletterSubscribe(data, socket) {
  const email = data.email;

  if (!validateEmail(email)) return socket.send(JSON.stringify({
    "html": "Your email is invalid",
    "message": "updated html",
    "selector": "#emailMessage"
  }));

  return new Promise((resolve, reject) => {
    request({
      method: "POST",
      url: `https://api.lbry.io/list/subscribe?email=${email}`
    }).then(body => {
      if (!body || !JSON.parse(body)) {
        logSlackError(
          "\n" +
          "> *NEWSLETTER ERROR:* ```¯\\_(ツ)_/¯ This should be an unreachable error```" + "\n" +
          `> _Cause: ${email} interacted with the form_\n`
        );

        return resolve(socket.send(JSON.stringify({
          "html": "Something is terribly wrong",
          "message": "updated html",
          "selector": "#emailMessage"
        })));
      }

      body = JSON.parse(body);

      if (!body.success) {
        logSlackError(
          "\n" +
          "> *NEWSLETTER ERROR:* ```" + JSON.parse(JSON.stringify(body.error)) + "```" + "\n" +
          `> _Cause: ${email} interacted with the form_\n`
        );

        return reject(socket.send(JSON.stringify({
          "html": body.error,
          "message": "updated html",
          "selector": "#emailMessage"
        })));
      }

      return resolve(socket.send(JSON.stringify({
        "html": "Thank you! Please confirm subscription in your inbox.",
        "message": "updated html",
        "selector": "#emailMessage"
      })));
    }).catch(welp => {
      if (welp.statusCode === 409) {
        logSlackError(
          "\n" +
          "> *NEWSLETTER ERROR:* ```" + JSON.parse(JSON.stringify(welp.error)) + "```" + "\n" +
          `> _Cause: ${email} interacted with the form_\n`
        );

        return resolve(socket.send(JSON.stringify({
          "html": "You have already subscribed!",
          "message": "updated html",
          "selector": "#emailMessage"
        })));
      }
    });
  });
}

function updateGithubFeed() {
  octokit.activity.getEventsForOrg({
    org: "lbryio",
    per_page: 20,
    page: 1
  }).then(({ data }) => {
    async.eachSeries(data, (item, callback) => {
      const eventString = JSON.stringify(item);

      client.zrank("events", eventString, (err, reply) => {
        if (reply === null) client.zadd("events", item.id, eventString, callback);
        else callback();
      });
    }, () => client.zremrangebyrank("events", 0, -51)); // Keep the latest 50 events
  }).catch(err => {
    logSlackError(
      "\n" +
      "> *GITHUB FEED ERROR:* ```" + JSON.parse(JSON.stringify(err)) + "```" + "\n" +
      "> _Cause: GitHub feed refresh_\n"
    );
  });
}

function uploadImage(imageSource) {
  return new Promise((resolve, reject) => {
    request({
      body: imageSource,
      headers: {
        "Content-Type": "text/plain"
      },
      method: "PUT",
      qs: {
        access_token: process.env.LBRY_DAEMON_ACCESS_TOKEN
      },
      url: "http://daemon.lbry.tech/images.php"
    }, (error, response, body) => {
      if (error) reject(error);
      body = JSON.parse(body);
      resolve(body);
    });
  });
}

function validateEmail(email) {
  const re = /^(([^<>()[\].,;:\s@"]+(\.[^<>()[\].,;:\s@"]+)*)|(".+"))@(([^<>()[\].,;:\s@"]+\.)+[^<>()[\\.,;:\s@"]{2,})$/i;
  return re.test(String(email));
}
