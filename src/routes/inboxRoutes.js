import { ImapFlow } from "imapflow";
import Poplib from "poplib";
import { simpleParser } from "mailparser";
import { decrypt } from "../utils/cryptoUtils.js";

const inboxRoutes = (fastify, opts, done) => {
  const users = () => fastify.mongo.db.collection("users");

  function cleanExcerpt(text) {
    if (!text) return "";
    return text
      .replace(/\[image:[^\]]+\]/gi, "")
      .replace(/\.{3,}/g, "...")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 200);
  }

  function fallbackKey(parsed, envelope) {
    const subj = (envelope?.subject || parsed?.subject || "").trim();
    const date = (envelope?.date || parsed?.date || "").toString();
    const from = (envelope?.from || parsed?.from?.text || "").toString();
    return `${subj}|${date}|${from}`.substring(0, 300);
  }

  // -------------------- IMAP: Fetch Mail (Universal) --------------------
  async function fetchViaImap({
    host,
    port,
    secure,
    user,
    pass,
    limit = 50,
    folder = "INBOX",
  }) {
    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass },
      logger: false,
    });

    await client.connect();

    try {
      // mapping to prefer when searching for specific logical folder
      const folderMap = {
        INBOX: ["INBOX"],
        SPAM: ["Spam", "Junk", "Bulk Mail", "Junk E-mail", "[Gmail]/Spam"],
        SENT: ["Sent", "Sent Mail", "[Gmail]/Sent Mail"],
        DRAFTS: ["Drafts", "[Gmail]/Drafts"],
        TRASH: ["Trash", "Deleted Items", "[Gmail]/Trash"],
        ARCHIVE: ["Archive", "All Mail", "[Gmail]/All Mail"],
      };

      // If not "ALL", try open the mapped folders (existing behavior)
      if (folder.toUpperCase() !== "ALL") {
        const tryFolders = folderMap[folder.toUpperCase()] || [folder];
        let mailbox;
        for (const f of tryFolders) {
          try {
            mailbox = await client.mailboxOpen(f);
            break;
          } catch {
            continue;
          }
        }
        if (!mailbox) {
          await client.logout().catch(() => {});
          throw new Error(`Unable to open folder "${folder}" or any fallbacks`);
        }

        const total = mailbox.exists;
        const start = Math.max(1, total - (limit - 1));
        const seq = `${start}:${total}`;
        const messages = [];

        for await (const msg of client.fetch(seq, {
          envelope: true,
          source: true,
        })) {
          let bodyText = "";
          let excerpt = "";
          let toField = "";
          let parsed;
          try {
            parsed = msg.source ? await simpleParser(msg.source) : null;
            bodyText = parsed?.html || parsed?.textAsHtml || parsed?.text || "";
            excerpt = cleanExcerpt(parsed?.text || parsed?.textAsHtml || "");
            if (parsed?.to) {
              toField = parsed.to.value
                .map((t) => t.name || t.address)
                .join(", ");
            }
          } catch {
            bodyText = "";
            excerpt = "(failed to parse)";
          }

          messages.push({
            id: msg.uid,
            subject: msg.envelope?.subject || "(no subject)",
            from: (msg.envelope?.from || [])
              .map((f) => f.name || f.address || "(unknown)")
              .join(", "),
            to: toField,
            date: msg.envelope?.date,
            excerpt,
            body: bodyText,
            mailbox: mailbox.path, // tag with mailbox path
            messageId: parsed?.messageId || undefined, // for dedupe
          });
        }

        await client.logout().catch(() => {});
        return messages.reverse();
      }

      // ---------- folder === "ALL" path ----------
      // list all mailboxes and pick likely candidates (provider-agnostic)
      const boxes = await client.list(); // returns array of { path, ... }
      // Normalize list and pick candidates by name pattern
      const lowerName = (s) => (s || "").toString().toLowerCase();

      // candidate patterns we care about (order = priority)
      const patterns = [
        /inbox/i,
        /sent/i,
        /archive|all mail|archive/i,
        /spam|junk|bulk/i,
        /trash|deleted/i,
        // skip drafts unless you want them:
        // /draft/i,
        // you may add more patterns if necessary
      ];

      // collect matching mailboxes (preserve server path)
      const candidates = [];

      for (const box of boxes) {
        const p = box.path || box.name || "";
        for (const pat of patterns) {
          if (pat.test(p)) {
            candidates.push({ path: p, priority: patterns.indexOf(pat) });
            break;
          }
        }
      }

      // Always ensure INBOX is present and first
      if (!candidates.some((c) => /inbox/i.test(c.path))) {
        // try to find a mailbox that equals INBOX case-insensitive
        const inboxBox = boxes.find(
          (b) => lowerName(b.path || b.name) === "inbox"
        );
        if (inboxBox) candidates.unshift({ path: inboxBox.path, priority: 0 });
      }

      // If no candidates matched, as fallback, choose top-level boxes (limit a few)
      if (candidates.length === 0) {
        // fallback: take up to 6 boxes from server list
        candidates.push(
          ...boxes
            .slice(0, 6)
            .map((b, i) => ({ path: b.path, priority: 99 + i }))
        );
      }

      // We will fetch `limit` messages total, spread across candidates.
      // Strategy: per-mailbox limit = Math.ceil(limit / candidates.length) + small buffer
      const perMailboxLimit = Math.max(
        10,
        Math.ceil(limit / Math.max(1, candidates.length))
      );

      // Map to hold deduped messages keyed by messageId (or fallback)
      const seen = new Map();
      const collected = [];

      // Iterate over candidates by priority
      candidates.sort((a, b) => a.priority - b.priority);

      for (const box of candidates) {
        let mailbox;
        try {
          mailbox = await client.mailboxOpen(box.path);
        } catch {
          continue; // skip if cannot open
        }

        const total = mailbox.exists;
        if (!total || total === 0) {
          await client.mailboxClose().catch(() => {});
          continue;
        }

        const start = Math.max(1, total - (perMailboxLimit - 1));
        const seq = `${start}:${total}`;

        for await (const msg of client.fetch(seq, {
          envelope: true,
          source: true,
        })) {
          let bodyText = "";
          let excerpt = "";
          let toField = "";
          let parsed;
          try {
            parsed = msg.source ? await simpleParser(msg.source) : null;
            bodyText = parsed?.html || parsed?.textAsHtml || parsed?.text || "";
            excerpt = cleanExcerpt(parsed?.text || parsed?.textAsHtml || "");
            if (parsed?.to) {
              toField = parsed.to.value
                .map((t) => t.name || t.address)
                .join(", ");
            }
          } catch {
            bodyText = "";
            excerpt = "(failed to parse)";
          }

          const messageId = parsed?.messageId;
          const key = messageId || fallbackKey(parsed, msg.envelope);

          // If we already have the same message, add mailbox to its tags array instead of duplicating
          if (seen.has(key)) {
            const existing = seen.get(key);
            // push mailbox name if not present
            if (!existing.mailboxes.includes(mailbox.path)) {
              existing.mailboxes.push(mailbox.path);
            }
            continue;
          }

          const entry = {
            id: msg.uid,
            subject: msg.envelope?.subject || "(no subject)",
            from: (msg.envelope?.from || [])
              .map((f) => f.name || f.address || "(unknown)")
              .join(", "),
            to: toField,
            date: msg.envelope?.date,
            excerpt,
            body: bodyText,
            mailboxes: [mailbox.path],
            mailbox: mailbox.path,
            messageId,
          };

          seen.set(key, entry);
          collected.push(entry);

          if (collected.length >= limit) break;
        }

        await client.mailboxClose().catch(() => {});
        if (collected.length >= limit) break;
      }

      await client.logout().catch(() => {});

      collected.sort((a, b) => new Date(b.date) - new Date(a.date));

      return collected.slice(0, limit);
    } finally {
    }
  }

  // -------------------- IMAP: Fetch Single Mail --------------------
  async function fetchSingleImap({
    host,
    port,
    secure,
    user,
    pass,
    uid,
    mailbox = "INBOX",
  }) {
    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass },
      logger: false,
    });

    await client.connect();
    let targetBox = mailbox || "INBOX";
    const lower = targetBox.toLowerCase();

    if (lower === "spam" || lower === "junk") targetBox = "[Gmail]/Spam";
    if (lower === "trash") targetBox = "[Gmail]/Trash";
    if (lower === "sent") targetBox = "[Gmail]/Sent Mail";
    if (lower === "important") targetBox = "[Gmail]/Important";

    const lock = await client.getMailboxLock(targetBox);

    try {
      const messages = [];
      for await (const msg of client.fetch(
        { uid: Number(uid) },
        { source: true, envelope: true }
      )) {
        let bodyHtml = "";
        let excerpt = "";
        let toField = "";

        if (msg.source) {
          const parsed = await simpleParser(msg.source);

          bodyHtml = parsed.html || parsed.textAsHtml || parsed.text || "";
          const textForExcerpt = parsed.text || parsed.textAsHtml || "";
          excerpt = textForExcerpt
            .replace(/\s+/g, " ")
            .trim()
            .substring(0, 200);

          if (parsed.to) {
            toField = parsed.to.value
              .map((t) => t.name || t.address)
              .join(", ");
          }
        }

        messages.push({
          id: msg.uid,
          mailbox,
          subject: msg.envelope.subject || "(no subject)",
          from: (msg.envelope.from || [])
            .map((f) => f.name || f.address || "(unknown)")
            .join(", "),
          to: toField,
          date: msg.envelope.date,
          excerpt,
          body: bodyHtml,
        });
      }

      return messages[0] || null;
    } finally {
      lock.release();
      await client.logout().catch(() => {});
    }
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

      client.on("top", async (status, msgNumber, data) => {
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
            body: parsed.text || "",
          });
        } catch {
          fetched.push({
            id: msgNumber,
            subject: "(parse error)",
            from: "(unknown)",
            date: null,
            excerpt: "",
            body: "",
          });
        }
        fetchNext();
      });

      client.on("quit", () => resolve(fetched));
    });
  }

  // --------------------Fetch and Filter Helper --------------------
  async function fetchAndFilterMails(req, reply, fastify, fieldName, flagName) {
    try {
      const userDoc = await users().findOne(
        { email: req.user.email },
        {
          projection: {
            "incomingServer.password": 1,
            "incomingServer.serverType": 1,
            "incomingServer.serverName": 1,
            "incomingServer.port": 1,
            "incomingServer.security": 1,
            "incomingServer.email": 1,
            [fieldName]: 1,
          },
        }
      );

      if (!userDoc || !userDoc.incomingServer) {
        return reply
          .status(404)
          .send({ message: "Incoming server not configured" });
      }

      const inc = userDoc.incomingServer;
      if (!inc.password || typeof inc.password !== "object") {
        return reply.status(400).send({
          message:
            "Password not stored in reversible form. User must re-enter password.",
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
          pass: plainPass,
          limit: 100,
        });
      } else if (serverType === "POP3") {
        fetched = await fetchViaPop3({
          host: inc.serverName,
          port: Number(inc.port),
          tls:
            (inc.security || "").toUpperCase().includes("SSL") ||
            Number(inc.port) === 995,
          user: inc.email,
          pass: plainPass,
          limit: 100,
        });
      } else {
        return reply
          .status(400)
          .send({ message: "Unsupported incoming server type" });
      }

      const idSet = new Set(userDoc[fieldName] || []);
      const messages = fetched
        .filter((msg) => idSet.has(msg.id.toString()))
        .map((msg) => ({
          ...msg,
          [flagName]: true,
        }));

      return reply.send({ provider: serverType, messages });
    } catch (err) {
      fastify.log.error(`${flagName} fetch error:`, err);
      return reply.status(500).send({ error: err.message });
    }
  }

  // -------------------- Routes --------------------
  fastify.get(
    "/inbox",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      try {
        const userDoc = await users().findOne(
          { email: req.user.email },
          {
            projection: {
              "incomingServer.password": 1,
              "incomingServer.serverType": 1,
              "incomingServer.serverName": 1,
              "incomingServer.port": 1,
              "incomingServer.security": 1,
              "incomingServer.email": 1,
              starredMails: 1,
              archivedMails: 1,
              deletedMails: 1,
            },
          }
        );

        if (!userDoc || !userDoc.incomingServer) {
          return reply
            .status(404)
            .send({ message: "Incoming server not configured" });
        }

        const inc = userDoc.incomingServer;
        if (!inc.password || typeof inc.password !== "object") {
          return reply.status(400).send({
            message:
              "Password not stored in reversible form. User must re-enter password.",
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
            pass: plainPass,
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
            pass: plainPass,
            limit: 50,
          });
        } else {
          return reply
            .status(400)
            .send({ message: "Unsupported incoming server type" });
        }

        const starredSet = new Set(userDoc.starredMails || []);
        const archivedSet = new Set(userDoc.archivedMails || []);
        const deletedSet = new Set(userDoc.deletedMails || []);

        const messages = fetched
          .filter(
            (msg) =>
              !archivedSet.has(msg.id.toString()) &&
              !deletedSet.has(msg.id.toString())
          )
          .map((msg) => ({
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

  // -------------------- All Mail Route --------------------
  fastify.get(
    "/all-mail",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      try {
        const userDoc = await users().findOne(
          { email: req.user.email },
          {
            projection: {
              "incomingServer.password": 1,
              "incomingServer.serverType": 1,
              "incomingServer.serverName": 1,
              "incomingServer.port": 1,
              "incomingServer.security": 1,
              "incomingServer.email": 1,
            },
          }
        );

        if (!userDoc || !userDoc.incomingServer) {
          return reply
            .status(404)
            .send({ message: "Incoming server not configured" });
        }

        const inc = userDoc.incomingServer;

        if (!inc.password || typeof inc.password !== "object") {
          return reply.status(400).send({
            message:
              "Password not stored in reversible form. User must re-enter password.",
          });
        }

        const plainPass = decrypt(inc.password);
        const serverType = (inc.serverType || "IMAP").toUpperCase();

        if (serverType !== "IMAP") {
          return reply.status(400).send({
            message: "All Mail fetching is only supported for IMAP accounts.",
          });
        }

        const fetched = await fetchViaImap({
          host: inc.serverName,
          port: Number(inc.port),
          secure:
            (inc.security || "").toUpperCase().includes("SSL") ||
            Number(inc.port) === 993,
          user: inc.email,
          pass: plainPass,
          folder: "ALL",
          limit: 50,
        });

        const mailboxUsed = fetched.length > 0 ? fetched[0].folder : "ALL";

        return reply.send({
          provider: serverType,
          folder: mailboxUsed,
          count: fetched.length,
          messages: fetched,
        });
      } catch (err) {
        fastify.log.error("All Mail fetch error:", err);
        return reply.status(500).send({ error: err.message });
      }
    }
  );

  // -------------------- Spam Route --------------------
  fastify.get(
    "/spam",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      try {
        const userDoc = await users().findOne(
          { email: req.user.email },
          {
            projection: {
              "incomingServer.password": 1,
              "incomingServer.serverType": 1,
              "incomingServer.serverName": 1,
              "incomingServer.port": 1,
              "incomingServer.security": 1,
              "incomingServer.email": 1,
            },
          }
        );

        if (!userDoc || !userDoc.incomingServer) {
          return reply
            .status(404)
            .send({ message: "Incoming server not configured" });
        }

        const inc = userDoc.incomingServer;
        if (!inc.password || typeof inc.password !== "object") {
          return reply.status(400).send({
            message:
              "Password not stored in reversible form. User must re-enter password.",
          });
        }

        const plainPass = decrypt(inc.password);
        const serverType = (inc.serverType || "IMAP").toUpperCase();

        if (serverType !== "IMAP") {
          return reply.status(400).send({
            message:
              "Spam folder fetching is only supported for IMAP accounts.",
          });
        }

        // Fetch from IMAP "Spam" folder
        const fetched = await fetchViaImap({
          host: inc.serverName,
          port: Number(inc.port),
          secure:
            (inc.security || "").toUpperCase().includes("SSL") ||
            Number(inc.port) === 993,
          user: inc.email,
          pass: plainPass,
          folder: "Spam",
          limit: 50,
        });

        return reply.send({ provider: serverType, messages: fetched });
      } catch (err) {
        fastify.log.error("Spam fetch error:", err);
        return reply.status(500).send({ error: err.message });
      }
    }
  );

  // -------------------- Fetch Starred Emails --------------------
  fastify.get(
    "/starred",
    { preHandler: [fastify.authenticate] },
    (req, reply) =>
      fetchAndFilterMails(req, reply, fastify, "starredMails", "starred")
  );

  // -------------------- Fetch Archived Emails --------------------
  fastify.get(
    "/archived",
    { preHandler: [fastify.authenticate] },
    (req, reply) =>
      fetchAndFilterMails(req, reply, fastify, "archivedMails", "archived")
  );

  // -------------------- Fetch Deleted Emails --------------------
  fastify.get(
    "/deleted",
    { preHandler: [fastify.authenticate] },
    (req, reply) =>
      fetchAndFilterMails(req, reply, fastify, "deletedMails", "deleted")
  );

  fastify.get(
    "/mail/:mailbox/:uid",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      try {
        const uid = Number(req.params.uid);
        const mailbox = req.params.mailbox;
        if (isNaN(uid)) return reply.code(400).send({ error: "Invalid UID" });

        const userDoc = await users().findOne(
          { email: req.user.email },
          {
            projection: {
              "incomingServer.password": 1,
              "incomingServer.serverType": 1,
              "incomingServer.serverName": 1,
              "incomingServer.port": 1,
              "incomingServer.security": 1,
              "incomingServer.email": 1,
              starredMails: 1,
            },
          }
        );

        if (!userDoc || !userDoc.incomingServer)
          return reply
            .status(404)
            .send({ message: "Incoming server not configured" });

        const inc = userDoc.incomingServer;
        if (!inc.password || typeof inc.password !== "object")
          return reply.status(400).send({
            message:
              "Password not stored in reversible form. User must re-enter password.",
          });

        const plainPass = decrypt(inc.password);
        const serverType = (inc.serverType || "IMAP").toUpperCase();

        let mail;
        if (serverType === "IMAP") {
          mail = await fetchSingleImap({
            host: inc.serverName,
            port: Number(inc.port),
            secure:
              (inc.security || "").toUpperCase().includes("SSL") ||
              Number(inc.port) === 993,
            user: inc.email,
            pass: plainPass,
            uid,
            mailbox,
          });

          if (!mail)
            return reply.status(404).send({ message: "Mail not found" });
        } else if (serverType === "POP3") {
          const fetched = await fetchViaPop3({
            host: inc.serverName,
            port: Number(inc.port),
            tls:
              (inc.security || "").toUpperCase().includes("SSL") ||
              Number(inc.port) === 995,
            user: inc.email,
            pass: plainPass,
            limit: 50,
          });
          mail = fetched.find((m) => Number(m.id) === uid);
          if (!mail)
            return reply.status(404).send({ message: "Mail not found" });
        } else {
          return reply
            .status(400)
            .send({ message: "Unsupported incoming server type" });
        }

        mail.starred = (userDoc.starredMails || []).includes(
          mail.id.toString()
        );
        return reply.send({ mail, provider: serverType });
      } catch (err) {
        fastify.log.error("Fetch mail error:", err);
        return reply.status(500).send({ error: err.message });
      }
    }
  );

  fastify.post(
    "/archive-mail",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      try {
        const { mailId } = req.body;
        const userEmail = req.user.email;

        await users().updateOne(
          { email: userEmail },
          { $addToSet: { archivedMails: mailId } }
        );

        return reply.send({ success: true });
      } catch (err) {
        return reply.status(500).send({ error: err.message });
      }
    }
  );

  fastify.post(
    "/delete-mail",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      try {
        const { mailId } = req.body;
        const userEmail = req.user.email;

        console.log(mailId);

        await users().updateOne(
          { email: userEmail },
          { $addToSet: { deletedMails: mailId } }
        );

        return reply.send({ success: true });
      } catch (err) {
        return reply.status(500).send({ error: err.message });
      }
    }
  );

  fastify.post(
    "/star-mail",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      const { mailId } = req.body;
      if (!mailId) return reply.code(400).send({ error: "mailId is required" });

      await users().updateOne(
        { email: req.user.email },
        { $addToSet: { starredMails: mailId.toString() } }
      );
      return reply.send({ success: true, mailId });
    }
  );

  fastify.delete(
    "/unstar-mail/:mailId",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      const { mailId } = req.params;
      await users().updateOne(
        { email: req.user.email },
        { $pull: { starredMails: mailId.toString() } }
      );
      return reply.send({ success: true, mailId });
    }
  );

  done();
};

export default inboxRoutes;
