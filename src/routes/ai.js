// import OpenAI from "openai";

// export default async function aiRoutes(fastify, options) {
//   const openai = new OpenAI({
//     apiKey: process.env.OPENAI_API_KEY,
//   });

//   fastify.post("/ai/write", async (req, reply) => {
//     try {
//       const { prompt, subject, recipients, model } = req.body;

//       if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
//         return reply.code(400).send({ error: "Prompt is required" });
//       }

//       const chosenModel =
//         model === "gpt-4o-mini" ? "gpt-4o-mini" : "gpt-3.5-turbo";

//       const context = `
// You are an AI email writing assistant.
// Write a clear, polite, and professional email based on this request:

// Prompt: "${prompt}"

// Subject: ${subject || "(none)"}
// Recipients: ${recipients?.join(", ") || "(not specified)"}

// Output only the email body (greeting, message, and closing).
// `;

//       const completion = await openai.chat.completions.create({
//         model: chosenModel,
//         messages: [
//           { role: "system", content: "You are a professional email writer." },
//           { role: "user", content: context },
//         ],
//         temperature: 0.7,
//         max_tokens: 600,
//       });

//       const message = completion.choices?.[0]?.message?.content?.trim();

//       if (!message) {
//         return reply
//           .code(500)
//           .send({ error: "AI returned an empty response." });
//       }

//       return reply.send({ content: message });
//     } catch (err) {
//       console.error("AI route error:", err);

//       if (err.code === "insufficient_quota" || err.status === 429) {
//         return reply.status(429).send({
//           error: "AI quota exceeded. Please check your OpenAI plan or billing.",
//         });
//       }

//       if (err instanceof Error) {
//         return reply.status(500).send({ error: err.message });
//       }

//       return reply.status(500).send({ error: "Unknown AI error occurred." });
//     }
//   });
// }

import OpenAI from "openai";

export default async function aiRoutes(fastify, options) {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  fastify.post("/ai/write", async (req, reply) => {
    try {
      const { prompt, subject, recipients } = req.body;

      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        return reply.code(400).send({ error: "Prompt is required" });
      }

      const isDev = process.env.NODE_ENV === "development";
      if (isDev) {
        const mockResponse = `MOCK RESPONSE: This is a generated email for prompt: "${prompt}`;
        return reply.send({ content: mockResponse });
      }

      const context = `
You are an AI email writing assistant.
Write a clear, polite, and professional email based on this request:

Prompt: "${prompt}"

Subject: ${subject || "(none)"}
Recipients: ${recipients?.join(", ") || "(not specified)"}

Output only the email body (greeting, message, and closing).
`;

      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "You are a professional email writer." },
          { role: "user", content: context },
        ],
        temperature: 0.7,
        max_tokens: 400,
      });

      const message = completion.choices?.[0]?.message?.content?.trim();

      if (!message) {
        return reply
          .code(500)
          .send({ error: "AI returned an empty response." });
      }

      return reply.send({ content: message });
    } catch (err) {
      console.error("AI route error:", err);

      if (err.code === "insufficient_quota" || err.status === 429) {
        const fallbackMessage = `MOCK RESPONSE: Your AI quota is exceeded. Here's a placeholder email for: "${req.body.prompt}"`;
        return reply.status(200).send({ content: fallbackMessage });
      }

      if (err instanceof Error) {
        return reply.status(500).send({ error: err.message });
      }

      return reply.status(500).send({ error: "Unknown AI error occurred." });
    }
  });
}
