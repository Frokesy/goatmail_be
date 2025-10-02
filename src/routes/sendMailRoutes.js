import dotenv from "dotenv";
dotenv.config();
import SMTPConnection from "smtp-connection";
import { decrypt } from "../utils/cryptoUtils.js";
import { ObjectId } from "mongodb";

const sendMailRoutes = (fastify, opts, done) => {
        const users = () => fastify.mongo.db.collection("users");
        const sent = () => fastify.mongo.db.collection("sentEmails");

        fastify.post(
                "/send-email", { preHandler: [fastify.authenticate] },
                async(req, reply) => {
                    try {
                        const { to, cc, bcc, subject, body, name, track } = req.body;

                        if (!to || !subject || !body) {
                            return reply.status(400).send({ error: "Missing required fields" });
                        }

                        const userDoc = await users().findOne({ email: req.user.email }, {
                            projection: {
                                "outgoingEmail.password": 1,
                                "outgoingEmail.smtpServer": 1,
                                "outgoingEmail.securityType": 1,
                                "outgoingEmail.port": 1,
                                "outgoingEmail.email": 1,
                            },
                        });

                        if (!userDoc || !userDoc.outgoingEmail) {
                            return reply
                                .status(404)
                                .send({ message: "SMTP details not configured" });
                        }

                        const out = userDoc.outgoingEmail;
                        if (!out.password || typeof out.password !== "object") {
                            return reply.status(400).send({
                                message: "Password not stored in reversible form. User must re-enter password.",
                            });
                        }

                        const plainPass = decrypt(out.password);

                        // 🔹 Tracking injection
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

                        // 🔹 Create SMTP connection (handles SSL & STARTTLS safely)
                        const connection = new SMTPConnection({
                            host: out.smtpServer,
                            port: Number(out.port),
                            secure:
                                (out.securityType || "").toUpperCase().includes("SSL") ||
                                Number(out.port) === 465,
                            tls: { rejectUnauthorized: false }, // allow self-signed
                        });

                        const connectPromise = () =>
                            new Promise((resolve, reject) => {
                                connection.connect((err) => {
                                    if (err) reject(err);
                                    else resolve(true);
                                });
                            });

                        const loginPromise = () =>
                            new Promise((resolve, reject) => {
                                connection.login({
                                        user: out.email,
                                        // 🔹 keep your hardcoded password
                                        pass: plainPass,
                                    },
                                    (err) => {
                                        if (err) reject(err);
                                        else resolve(true);
                                    }
                                );
                            });

                        const sendPromise = () =>
                            new Promise((resolve, reject) => {
                                    const senderName = name || out.email.split("@")[0];
                                    const fromHeader = `"${senderName}" <${out.email}>`;

                                    const recipients = []
                                        .concat(to || [])
                                        .concat(cc || [])
                                        .concat(bcc || [])
                                        .filter(Boolean);

                                    // 🔹 Proper MIME message
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
                if (err) reject(err);
                else resolve(info);
              }
            );
          });

        const quitPromise = () =>
          new Promise((resolve) => {
            connection.quit();
            resolve(true);
          });

        // 🔹 Flow
        await connectPromise();
        await loginPromise();
        const info = await sendPromise();
        await quitPromise();

        // 🔹 Save to DB
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
        console.error("SMTP Error:", err);
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