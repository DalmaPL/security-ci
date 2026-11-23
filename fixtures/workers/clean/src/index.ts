export interface Env {
  ENVIRONMENT: string;
  API_TOKEN: string; // secret: wrangler secret put API_TOKEN
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, environment: env.ENVIRONMENT });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
