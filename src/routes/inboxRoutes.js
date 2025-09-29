import { ImapFlow } from "imapflow";
import Poplib from "poplib";
import { simpleParser } from "mailparser";
import { decrypt } from "../utils/cryptoUtils.js";

const inboxRoutes = (fastify, opts, done) => {
    const users = () => fastify.mongo.db.collection("users");

    // -------------------- IMAP --------------------
    async function fetchViaImap({ host, port, secure, user, pass, limit = 50 }) {
        const client = new ImapFlow({
            host,
            port,
            secure,
            auth: { user, pass },
            logger: false,
        });

        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        const messages = [];
        try {
            const mailbox = await client.mailboxOpen("INBOX");
            const total = mailbox.exists;
            const start = Math.max(1, total - (limit - 1));
            const seq = `${start}:${total}`;

            for await (let msg of client.fetch(seq, {
                envelope: true,
                source: true,
            })) {
                let excerpt = "";
                if (msg.source) {
                    try {
                        const parsed = await simpleParser(msg.source);
                        excerpt = parsed.text ? parsed.text.substring(0, 200) : "";
                    } catch (err) {
                        excerpt = "(failed to parse)";
                    }
                }

                messages.push({
                    id: msg.uid,
                    subject: msg.envelope.subject,
                    from: (msg.envelope.from || []).map((f) => f.address).join(", "),
                    to: (msg.envelope.to || []).map((t) => t.address).join(", "),
                    date: msg.envelope.date,
                    excerpt,
                });
            }
        } finally {
            lock.release();
            await client.logout().catch(() => {});
        }
        return messages.reverse();
    }

    // -------------------- POP3 --------------------
    function fetchViaPop3({ host, port, tls, user, pass, limit = 50 }) {
        return new Promise((resolve, reject) => {
            const client = new Poplib(port, host, {
                tlserrs: false,
                enabletls: tls,
                debug: false,
            });

            const fetched = [];
            let total = 0;
            let ids = [];
            let idx = 0;

            client.on("error", (err) => {
                client.quit();
                reject(err);
            });

            client.on("connect", () => {
                client.login(user, pass);
            });

            client.on("login", (status) => {
                if (!status) {
                    client.quit();
                    return reject(new Error("POP3 login failed"));
                }
                client.stat();
            });

            client.on("stat", (status, msgcount) => {
                if (!status) {
                    client.quit();
                    return reject(new Error("POP3 STAT failed"));
                }
                total = msgcount;
                if (total === 0) {
                    client.quit();
                    return resolve([]);
                }

                const start = Math.max(1, total - (limit - 1));
                ids = [];
                for (let i = total; i >= start; i--) ids.push(i);

                fetchNext();
            });

            const fetchNext = () => {
                if (idx >= ids.length) {
                    client.quit();
                    return resolve(fetched);
                }
                const msgNum = ids[idx++];
                client.top(msgNum, 20);
            };

            client.on("top", async(status, msgNumber, data) => {
                if (!status) return fetchNext();

                try {
                    const parsed = await simpleParser(data);
                    const excerpt = parsed.text ? parsed.text.substring(0, 200) : "";

                    fetched.push({
                        id: msgNumber,
                        subject: parsed.subject || "(no subject)",
                        from: parsed.from ? parsed.from.text : "(unknown)",
                        date: parsed.date ? parsed.date.toISOString() : null,
                        excerpt,
                    });
                } catch (err) {
                    fetched.push({
                        id: msgNumber,
                        subject: "(parse error)",
                        from: "(unknown)",
                        date: null,
                        excerpt: "",
                    });
                }

                fetchNext();
            });

            client.on("quit", () => resolve(fetched));
        });
    }

    // -------------------- ROUTE --------------------
    fastify.get(
        "/inbox", { preHandler: [fastify.authenticate] },
        async(req, reply) => {
            try {
                const userDoc = await users().findOne({ email: req.user.email }, {
                    projection: {
                        "incomingServer.password": 1,
                        "incomingServer.serverType": 1,
                        "incomingServer.serverName": 1,
                        "incomingServer.port": 1,
                        "incomingServer.security": 1,
                        "incomingServer.email": 1,
                    },
                });

                if (!userDoc || !userDoc.incomingServer) {
                    return reply
                        .status(404)
                        .send({ message: "Incoming server not configured" });
                }

                const inc = userDoc.incomingServer;
                if (!inc.password || typeof inc.password !== "object") {
                    return reply.status(400).send({
                        message: "Password not stored in reversible form. User must re-enter password.",
                    });
                }

                const plainPass = decrypt(inc.password);
                const serverType = (inc.serverType || "IMAP").toUpperCase();

                if (serverType === "IMAP") {
                    const messages = await fetchViaImap({
                        host: inc.serverName,
                        port: Number(inc.port),
                        secure:
                            (inc.security || "").toUpperCase().includes("SSL") ||
                            Number(inc.port) === 993,
                        user: inc.email,
                        pass: "vqxfsxjuqhsyiujr",
                        limit: 50,
                    });

                    return reply.send({ provider: "IMAP", messages });
                } else if (serverType === "POP3") {
                    const messages = await fetchViaPop3({
                        host: inc.serverName,
                        port: Number(inc.port),
                        tls:
                            (inc.security || "").toUpperCase().includes("SSL") ||
                            Number(inc.port) === 995,
                        user: inc.email,
                        pass: "vqxfsxjuqhsyiujr",
                        limit: 50,
                    });

                    return reply.send({ provider: "POP3", messages });
                } else {
                    return reply
                        .status(400)
                        .send({ message: "Unsupported incoming server type" });
                }
            } catch (err) {
                fastify.log.error("Inbox error:", err);
                return reply.status(500).send({ error: err.message });
            }
        }
    );

    done();
};

export default inboxRoutes;