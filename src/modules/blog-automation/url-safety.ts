export function isUrlSafe(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    
    // Only allow HTTP/HTTPS
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    // Reject known unsafe domains or localhosts
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === 'example.com'
    ) {
      return false;
    }

    // Reject typical private IP ranges (RFC1918)
    // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [_, p1, p2] = ipMatch;
      const o1 = parseInt(p1, 10);
      const o2 = parseInt(p2, 10);

      if (o1 === 10) return false;
      if (o1 === 172 && o2 >= 16 && o2 <= 31) return false;
      if (o1 === 192 && o2 === 168) return false;
      if (o1 === 169 && o2 === 254) return false; // link-local
    }

    return true;
  } catch (err) {
    return false; // Invalid URL
  }
}

export function normalizeUrl(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    // Remove hash/fragment and standardize to lowercase host
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return urlStr;
  }
}
