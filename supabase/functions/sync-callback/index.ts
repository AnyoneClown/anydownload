// The extension observes this tab's URL and exchanges the PKCE code itself.
// Never read or echo the URL: it can contain a short-lived authorization code.
Deno.serve(() => new Response(
  "Return to AnyDownload to finish signing in. You can close this tab after AnyDownload confirms your account.\n",
  {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff"
    }
  }
));
