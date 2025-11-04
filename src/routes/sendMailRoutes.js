import dotenv from "dotenv";
dotenv.config();
import SMTPConnection from "smtp-connection";
import { decrypt } from "../utils/cryptoUtils.js";
import { ObjectId } from "mongodb";

const sendMailRoutes = (fastify, opts, done) => {
  const users = () => fastify.mongo.db.collection("users");
  const sent = () => fastify.mongo.db.collection("sentEmails");

  fastify.post(
    "/send-email",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      try {
        const { to, cc, bcc, subject, body, name, track = false } = req.body;

        if (!to || !subject || !body) {
          return reply.status(400).send({ error: "Missing required fields" });
        }

        const userDoc = await users().findOne(
          { email: req.user.email },
          {
            projection: {
              "outgoingEmail.password": 1,
              "outgoingEmail.smtpServer": 1,
              "outgoingEmail.securityType": 1,
              "outgoingEmail.port": 1,
              "outgoingEmail.email": 1,
            },
          }
        );

        if (!userDoc || !userDoc.outgoingEmail) {
          return reply
            .status(404)
            .send({ message: "SMTP details not configured" });
        }

        const out = userDoc.outgoingEmail;
        if (!out.password || typeof out.password !== "object") {
          return reply.status(400).send({
            message:
              "Password not stored in reversible form. User must re-enter password.",
          });
        }

        const plainPass = decrypt(out.password);

        // 🔹 Body + Tracking (only if enabled)
        let finalBody = body;
        let trackingId;
        if (track) {
          trackingId = new ObjectId().toString();
          const pixelUrl = `${process.env.API_URL}/tracking/open/${trackingId}`;
          const trackingPixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none" />`;

          finalBody += `\n\n${trackingPixel}`;

          // Wrap links for click tracking
          finalBody = finalBody.replace(
            /(https?:\/\/[^\s]+)/g,
            (url) =>
              `${
                process.env.API_URL
              }/tracking/click/${trackingId}?redirect=${encodeURIComponent(
                url
              )}`
          );
        }

        // 🔹 Create SMTP connection with debug + event logging
        const connection = new SMTPConnection({
          host: out.smtpServer,
          port: Number(out.port),
          secure:
            (out.securityType || "").toUpperCase().includes("SSL") ||
            Number(out.port) === 465,
          tls: { rejectUnauthorized: false },
          debug: true,
        });

        connection.on("log", (info) => {
          console.log("[SMTP LOG]", info);
        });
        connection.on("error", (err) => {
          console.error("[SMTP ERROR EVENT]", err);
        });
        connection.on("end", () => {
          console.log("[SMTP CONNECTION CLOSED]");
        });
        connection.on("close", () => {
          console.log("[SMTP SOCKET CLOSED BY SERVER]");
        });

        const connectPromise = () =>
          new Promise((resolve, reject) => {
            console.log("[SMTP] Attempting connection...");
            connection.connect((err) => {
              if (err) {
                console.error("[SMTP] Connection failed:", err);
                reject(err);
              } else {
                console.log("[SMTP] Connected successfully");
                resolve(true);
              }
            });
          });

        const loginPromise = () =>
          new Promise((resolve, reject) => {
            console.log("[SMTP] Attempting login...");
            connection.login(
              {
                user: out.email,
                pass: plainPass,
              },
              (err) => {
                if (err) {
                  console.error("[SMTP] Login failed:", err);
                  reject(err);
                } else {
                  console.log("[SMTP] Authenticated successfully");
                  resolve(true);
                }
              }
            );
          });

        const sendPromise = () =>
          new Promise((resolve, reject) => {
            console.log("[SMTP] Preparing message...");
            const senderName = name || out.email.split("@")[0];
            const fromHeader = `"${senderName}" <${out.email}>`;

            const recipients = []
              .concat(to || [])
              .concat(cc || [])
              .concat(bcc || [])
              .filter(Boolean);

            const message = `From: ${fromHeader}
To: ${Array.isArray(to) ? to.join(", ") : to}
${
  cc ? `Cc: ${Array.isArray(cc) ? cc.join(", ") : cc}\n` : ""
}Subject: ${subject}
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8
Content-Transfer-Encoding: 7bit

<html>
  <body>
    ${finalBody}
  </body>
</html>
`;

            connection.send(
              { from: out.email, to: recipients },
              message,
              (err, info) => {
                if (err) {
                  console.error("[SMTP] Send failed:", err);
                  reject(err);
                } else {
                  console.log("[SMTP] Message sent successfully:", info);
                  resolve(info);
                }
              }
            );
          });

        const quitPromise = () =>
          new Promise((resolve) => {
            console.log("[SMTP] Quitting connection...");
            connection.quit();
            resolve(true);
          });

        await connectPromise();
        await loginPromise();
        const info = await sendPromise();
        await quitPromise();

        const emailDoc = {
          userId: userDoc._id,
          from: out.email,
          senderName: name,
          to,
          cc,
          bcc,
          subject,
          body,
          sentAt: new Date(),
          smtpInfo: info,
        };

        if (track) {
          emailDoc.trackingId = trackingId;
          emailDoc.opened = false;
          emailDoc.clicks = [];
        }

        await sent().insertOne(emailDoc);

        return reply.send({ success: true, info });
      } catch (err) {
        console.error("SMTP Error (catch):", err);
        return reply.status(500).send({ error: err.message });
      }
    }
  );

  fastify.get(
    "/sent-emails",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      console.log(req.user);
      try {
        const userId = req.user.userId;

        const emails = await sent()
          .find({ userId: new ObjectId(userId) })
          .sort({ _id: -1 })
          .toArray();

        return reply.send({ emails });
      } catch (err) {
        console.error("Fetch Sent Emails Error:", err);
        return reply.status(500).send({ error: err.message });
      }
    }
  );

  fastify.get(
    "/sent-emails/:id",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      try {
        const userId = req.user.userId;
        const emailId = req.params.id;

        if (!ObjectId.isValid(emailId)) {
          return reply.status(400).send({ error: "Invalid email ID" });
        }

        const email = await sent().findOne({
          _id: new ObjectId(emailId),
          userId: new ObjectId(userId),
        });

        if (!email) {
          return reply.status(404).send({ error: "Email not found" });
        }
        return reply.send({ email });
      } catch (err) {
        console.error("Fetch Single Sent Email Error:", err);
        return reply.status(500).send({ error: err.message });
      }
    }
  );

  // 🔹 Tracking routes
  fastify.get("/tracking/open/:id", async (req, reply) => {
    const { id } = req.params;

    await sent().updateOne(
      { trackingId: id },
      {
        $set: { opened: true },
        $push: {
          openEvents: {
            time: new Date(),
            ip: req.ip,
            ua: req.headers["user-agent"],
          },
        },
      }
    );

    reply
      .header(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate"
      )
      .header("Pragma", "no-cache")
      .header("Expires", "0")
      .header("Surrogate-Control", "no-store");

    // return 1x1 transparent gif
    const pixel = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      "base64"
    );
    reply.header("Content-Type", "image/gif").send(pixel);
  });

  fastify.get("/tracking/click/:id", async (req, reply) => {
    const { id } = req.params;
    const { redirect } = req.query;
    await sent().updateOne(
      { trackingId: id },
      { $push: { clicks: { url: redirect, time: new Date() } } }
    );
    reply.redirect(redirect);
  });

  done();
};

export default sendMailRoutes;
