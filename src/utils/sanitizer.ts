

const MAX_DEPTH = 5;
const MAX_KEYS = 50;
const MAX_ARRAY = 100;
const MAX_STRING = 2000;
const MAX_SERIALIZED_SIZE = 50 * 1024; // 50KB

const SECRET_PATTERNS = [
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]+\b/gi,
  /\bsb_agent_[A-Za-z0-9_-]+\b/gi,
  /(?:x-agent-credential)[:=]\s*([^\s]+)/gi,
  /(?:authorization)[:=]\s*(?:bearer\s+[^\s]+)/gi,
  /(?:Bearer\s+)(ey[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+)/gi,
  /(?:postgres|postgresql|mysql|mongodb|redis|rediss):\/\/[^:]+:[^@]+@[^\s"']+/gi,
  /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/g,
  /(?:X-Amz-Signature|X-Amz-Credential|sig|signature)=([a-zA-Z0-9%_-]+)/gi,
  /(?:AKIA|A3T|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g, // AWS Access Keys
  /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi
];

const SECRET_KEYS = new Set([
  'authorization', 'cookie', 'password', 'passwd', 'secret',
  'clientsecret', 'client_secret', 'privatekey', 'private_key', 'hmac', 'signature', 'set-cookie',
  'databaseurl', 'redisurl', 'connectionstring', 'servicerole',
  'servicerolekey', 'signedurl', 'presignedurl', 'callbackurl',
  'smtp', 'credential', 'token', 'accesstoken', 'refreshtoken',
  'api-key', 'apikey', 'api_key', 'x-agent-credential', 'jwt'
]);

function redactString(str: string): string {
  let redacted = str;
  if (redacted.length > MAX_STRING) {
    redacted = redacted.substring(0, MAX_STRING) + '...[TRUNCATED]';
  }
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      if (match.includes('@') && !match.startsWith('postgres') && !match.startsWith('redis')) {
        const [local, domain] = match.split('@');
        return `${local.substring(0, 2)}***@${domain}`;
      }
      return '[REDACTED]';
    });
  }
  return redacted;
}

function recursivelyRedact(obj: any, depth = 0, seen = new WeakSet()): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactString(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (typeof obj === 'function') return '[FUNCTION]';

  if (depth >= MAX_DEPTH) return '[MAX_DEPTH_REACHED]';

  if (typeof obj === 'object') {
    if (seen.has(obj)) return '[CIRCULAR]';
    seen.add(obj);

    if (Array.isArray(obj)) {
      const sliced = obj.slice(0, MAX_ARRAY);
      const mapped = sliced.map(item => recursivelyRedact(item, depth + 1, seen));
      if (obj.length > MAX_ARRAY) mapped.push('[MAX_ARRAY_LENGTH_REACHED]');
      return mapped;
    }

    if (obj instanceof Error) {
      return {
        name: obj.name,
        message: redactString(obj.message),
        stack: '[REDACTED_STACK]'
      };
    }

    const keys = Object.keys(obj).slice(0, MAX_KEYS);
    const newObj: Record<string, any> = {};
    for (const key of keys) {
      const lowerKey = key.toLowerCase().replace(/[-_\\s]/g, '');
      let isSecret = false;
      for (const secretKey of SECRET_KEYS) {
        if (lowerKey.includes(secretKey)) {
          isSecret = true;
          break;
        }
      }

      if (isSecret) {
        newObj[key] = '[REDACTED]';
      } else {
        newObj[key] = recursivelyRedact(obj[key], depth + 1, seen);
      }
    }
    if (Object.keys(obj).length > MAX_KEYS) newObj['__truncated'] = '[MAX_KEYS_REACHED]';
    return newObj;
  }
  return String(obj);
}

export function sanitizePayload(payload: unknown): unknown {
  try {
    const redacted = recursivelyRedact(payload);
    const serialized = JSON.stringify(redacted);
    if (serialized && serialized.length > MAX_SERIALIZED_SIZE) {
      return { _sanitization: '[PAYLOAD_TOO_LARGE]' };
    }
    return redacted;
  } catch (err) {
    return { _sanitization: '[SANITIZATION_FAILED]' };
  }
}
