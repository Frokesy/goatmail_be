import { ImapFlow } from "imapflow";
import Poplib from "poplib";
import { decryptPassword } from "../utils/crypto.js";

const inboxRoutes = (fastify, opts, done) => {
    const users = () => fastify.mongo.db.collection("users");

    // helper: connect via IMAP and fetch headers (most recent N)
    async function fetchViaImap({ host, port, secure, user, pass, limit = 20 }) {
        const client = new ImapFlow({
            host,
            port,
            secure,
            auth: { user, pass },
            logger: false,
        });

        await client.connect();
        // make sure mailbox exists
        const lock = await client.getMailboxLock("INBOX");
        const messages = [];
        try {
            // get mailbox exists count
            const mailbox = await client.mailboxOpen("INBOX");
            const total = mailbox.exists;
            // compute range for latest N
            const start = Math.max(1, total - (limit - 1));
            const seq = `${start}:${total}`;

            for await (let msg of client.fetch(seq, { envelope: true })) {
                messages.push({
                    id: msg.uid,
                    subject: msg.envelope.subject,
                    from: (msg.envelope.from || []).map((f) => f.address).join(", "),
                    to: (msg.envelope.to || []).map((t) => t.address).join(", "),
                    date: msg.envelope.date,
                });
            }
        } finally {
            lock.release();
            await client.logout().catch(() => {});
        }
        // newest first
        return messages.reverse();
    }

    // helper: fetch via POP3 (top lines -> get headers)
    function fetchViaPop3({ host, port, tls, user, pass, limit = 20 }) {
        return new Promise((resolve, reject) => {
            const client = new Poplib(port, host, {
                tlserrs: false,
                enabletls: tls,
                debug: false,
            });

            const messages = [];
            let total = 0;

            client.on("error", (err) => {
                client.quit();
                reject(err);
            });

            client.on("connect", () => {
                client.login(user, pass);
            });

            client.on("login", (status, rawdata) => {
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
                if (msgcount === 0) {
                    client.quit();
                    return resolve([]); // empty mailbox
                }

                // determine which messages to fetch (latest N)
                const start = Math.max(1, total - (limit - 1));
                const ids = [];
                for (let i = total; i >= start; i--) ids.push(i); // newest first

                // fetch sequentially using 'top' to get headers (0 lines of body)
                const fetched = [];
                let idx = 0;

                const fetchNext = () => {
                    if (idx >= ids.length) {
                        client.quit();
                        return resolve(fetched);
                    }
                    const msgNum = ids[idx++];
                    client.top(msgNum, 0); // top returns headers
                };

                client.on("top", (status, msgNumber, data, raw) => {
                    if (!status) {
                        // ignore a single failure and continue
                        if (idx >= ids.length) {
                            client.quit();
                            return resolve(fetched);
                        }
                        return fetchNext();
                    }
                    // data is the message headers + maybe lines. We parse minimal fields.
                    const headers = data.toString();
                    const subjectMatch = headers.match(/^Subject:\s*(.*)$/im);
                    const fromMatch = headers.match(/^From:\s*(.*)$/im);
                    const dateMatch = headers.match(/^Date:\s*(.*)$/im);

                    fetched.push({
                        id: msgNumber,
                        subject: subjectMatch ? subjectMatch[1].trim() : "(no subject)",
                        from: fromMatch ? fromMatch[1].trim() : "(unknown)",
                        date: dateMatch ?
                            new Date(dateMatch[1].trim()).toISOString() :
                            null,
                    });

                    fetchNext();
                });

                // start fetching
                fetchNext();
            });

            client.on("quit", (status, rawdata) => {
                if (!status) {
                    // if quit failed, still resolve what we have
                    resolve(messages);
                }
            });
        });
    }

    fastify.get(
        "/inbox", { preHandler: [fastify.authenticate] },
        async(req, reply) => {
            try {
                // find user and incoming server
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
                // password stored as object { ciphertext, iv, tag } — decrypt it
                if (!inc.password || typeof inc.password !== "object") {
                    return reply.status(400).send({
                        message: "Password not stored in reversible form. User must re-enter password.",
                    });
                }

                const plainPass = decryptPassword(inc.password); // may throw
                const serverType = (inc.serverType || "IMAP").toUpperCase();

                if (serverType === "IMAP") {
                    const messages = await fetchViaImap({
                        host: inc.serverName,
                        port: Number(inc.port),
                        secure:
                            (inc.security || "").toUpperCase().includes("SSL") ||
                            Number(inc.port) === 993,
                        user: inc.email,
                        pass: plainPass,
                        limit: 20,
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
                        pass: plainPass,
                        limit: 20,
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