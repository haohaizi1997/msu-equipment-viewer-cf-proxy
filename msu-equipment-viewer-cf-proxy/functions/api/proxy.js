const ALLOWED_ORIGIN = "https://msu.io";
const ALLOWED_PATH_PREFIX = "/navigator/api/navigator/";

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const targetUrl = requestUrl.searchParams.get("url");

  if (!targetUrl) {
    return jsonResponse(400, { error: "Missing url query parameter." });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return jsonResponse(400, { error: "Invalid target url." });
  }

  if (parsedUrl.origin !== ALLOWED_ORIGIN || !parsedUrl.pathname.startsWith(ALLOWED_PATH_PREFIX)) {
    return jsonResponse(400, { error: "Only msu navigator API URLs are allowed." });
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(parsedUrl.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*"
      },
      cf: {
        cacheTtl: 30,
        cacheEverything: false
      }
    });
  } catch {
    return jsonResponse(502, { error: "Failed to reach msu.io." });
  }

  const responseHeaders = new Headers();
  const contentType = upstreamResponse.headers.get("content-type");
  const cacheControl = upstreamResponse.headers.get("cache-control");

  if (contentType) {
    responseHeaders.set("Content-Type", contentType);
  } else {
    responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  }

  if (cacheControl) {
    responseHeaders.set("Cache-Control", cacheControl);
  } else {
    responseHeaders.set("Cache-Control", "no-store");
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders
  });
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: "GET, OPTIONS"
    }
  });
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
