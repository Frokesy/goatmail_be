import { ImapFlow } from "imapflow";
import Poplib from "poplib";
import { simpleParser } from "mailparser";
import { decrypt } from "../utils/cryptoUtils.js";

const inboxRoutes = (fastify, opts, done) => {
    const users = () => fastify.mongo.db.collection("users");

    // Utility to clean excerpts
    function cleanExcerpt(text) {
        if (!text) return "";
        return text
            .replace(/\[image:[^\]]+\]/gi, "") // remove [image: ...]
            .replace(/\.{3,}/g, "...") // collapse long dot sequences
            .replace(/\s+/g, " ") // normalize whitespace
            .trim()
            .substring(0, 200);
    }

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
                        excerpt = cleanExcerpt(parsed.text || "");
                    } catch {
                        excerpt = "(failed to parse)";
                    }
                }

                messages.push({
                    id: msg.uid,
                    subject: msg.envelope.subject || "(no subject)",
                    from: (msg.envelope.from || [])
                        .map((f) => f.name || f.address || "(unknown)")
                        .join(", "),
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

            client.on("connect", () => client.login(user, pass));

            client.on("login", (status) => {
                if (!status) return reject(new Error("POP3 login failed"));
                client.stat();
            });

            client.on("stat", (status, msgcount) => {
                if (!status) return reject(new Error("POP3 STAT failed"));
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
                    const excerpt = cleanExcerpt(parsed.text || "");

                    fetched.push({
                        id: msgNumber,
                        subject: parsed.subject || "(no subject)",
                        from: parsed.from ? parsed.from.text : "(unknown)",
                        date: parsed.date ? parsed.date.toISOString() : null,
                        excerpt,
                    });
                } catch {
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
                        starredMails: 1, // include starred mails field
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

                let fetched = [];
                if (serverType === "IMAP") {
                    fetched = await fetchViaImap({
                        host: inc.serverName,
                        port: Number(inc.port),
                        secure:
                            (inc.security || "").toUpperCase().includes("SSL") ||
                            Number(inc.port) === 993,
                        user: inc.email,
                        pass: "vqxfsxjuqhsyiujr",
                        limit: 50,
                    });
                } else if (serverType === "POP3") {
                    fetched = await fetchViaPop3({
                        host: inc.serverName,
                        port: Number(inc.port),
                        tls:
                            (inc.security || "").toUpperCase().includes("SSL") ||
                            Number(inc.port) === 995,
                        user: inc.email,
                        pass: "vqxfsxjuqhsyiujr",
                        limit: 50,
                    });
                } else {
                    return reply
                        .status(400)
                        .send({ message: "Unsupported incoming server type" });
                }

                // ⭐ Mark starred mails
                const starredSet = new Set(userDoc.starredMails || []);
                const messages = fetched.map((msg) => ({
                    ...msg,
                    starred: starredSet.has(msg.id.toString()),
                }));

                return reply.send({ provider: serverType, messages });
            } catch (err) {
                fastify.log.error("Inbox error:", err);
                return reply.status(500).send({ error: err.message });
            }
        }
    );

    fastify.post(
        "/star-mail", { preHandler: [fastify.authenticate] },
        async(req, reply) => {
            const { mailId } = req.body;

            if (!mailId) {
                return reply.code(400).send({ error: "mailId is required" });
            }

            await users().updateOne({ email: req.user.email }, { $addToSet: { starredMails: mailId.toString() } });

            return reply.send({ success: true, mailId });
        }
    );

    fastify.delete(
        "/unstar-mail/:mailId", { preHandler: [fastify.authenticate] },
        async(req, reply) => {
            const { mailId } = req.params;

            await users().updateOne({ email: req.user.email }, { $pull: { starredMails: mailId.toString() } });

            return reply.send({ success: true, mailId });
        }
    );

    done();
};

export default inboxRoutes;