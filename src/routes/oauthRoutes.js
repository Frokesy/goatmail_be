import fetch from "node-fetch";
import querystring from "querystring";

export default async function oauthRoutes(fastify) {
    fastify.get("/auth/oauth/google", async(req, reply) => {
        const { email } = req.query;

        const params = querystring.stringify({
            client_id: process.env.GOOGLE_CLIENT_ID,
            redirect_uri: process.env.GOOGLE_REDIRECT_URI,
            response_type: "code",
            access_type: "offline",
            prompt: "consent",
            scope: [
                "https://mail.google.com/",
                "https://www.googleapis.com/auth/userinfo.email",
                "https://www.googleapis.com/auth/userinfo.profile",
            ].join(" "),
            state: email,
        });

        reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    });

    fastify.get("/auth/oauth/google/callback", async(req, reply) => {
        const { code, state: email } = req.query;

        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: querystring.stringify({
                code,
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: process.env.GOOGLE_REDIRECT_URI,
                grant_type: "authorization_code",
            }),
        });

        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
            return reply
                .status(400)
                .send({ error: "Failed to exchange Google token" });
        }

        await fastify.mongo.db.collection("users").updateOne({ email }, {
            $set: {
                googleOAuth: {
                    accessToken: tokenData.access_token,
                    refreshToken: tokenData.refresh_token,
                    expiresIn: tokenData.expires_in,
                },
            },
        }, { upsert: true });

        reply.redirect(
            `goatmail://oauth2redirect?provider=google&email=${encodeURIComponent(
        email
      )}`
        );
    });

    // 🔹 Microsoft OAuth2 Start
    fastify.get("/auth/oauth/microsoft", async(req, reply) => {
        const { email } = req.query;

        const params = querystring.stringify({
            client_id: process.env.MICROSOFT_CLIENT_ID,
            response_type: "code",
            redirect_uri: process.env.MICROSOFT_REDIRECT_URI,
            response_mode: "query",
            scope: [
                "offline_access",
                "https://outlook.office.com/IMAP.AccessAsUser.All",
                "https://outlook.office.com/SMTP.Send",
                "User.Read",
            ].join(" "),
            state: email,
        });

        reply.redirect(
            `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`
        );
    });

    // 🔹 Microsoft OAuth2 Callback
    fastify.get("/auth/oauth/microsoft/callback", async(req, reply) => {
        const { code, state: email } = req.query;

        const tokenRes = await fetch(
            "https://login.microsoftonline.com/common/oauth2/v2.0/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: querystring.stringify({
                    client_id: process.env.MICROSOFT_CLIENT_ID,
                    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
                    redirect_uri: process.env.MICROSOFT_REDIRECT_URI,
                    grant_type: "authorization_code",
                    code,
                }),
            }
        );

        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
            return reply
                .status(400)
                .send({ error: "Failed to exchange Microsoft token" });
        }

        await fastify.mongo.db.collection("users").updateOne({ email }, {
            $set: {
                microsoftOAuth: {
                    accessToken: tokenData.access_token,
                    refreshToken: tokenData.refresh_token,
                    expiresIn: tokenData.expires_in,
                },
            },
        }, { upsert: true });

        reply.redirect(
            `goatmail://oauth2redirect?provider=microsoft&email=${encodeURIComponent(
        email
      )}`
        );
    });
}