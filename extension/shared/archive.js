(function attachImageDownloaderArchive(root) {
  "use strict";

  const UINT16_MAX = 0xffff;
  const UINT32_MAX = 0xffffffff;
  const UTF8_FLAG = 0x0800;
  const STORED_METHOD = 0;
  const VERSION_NEEDED = 20;

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      table[index] = value >>> 0;
    }
    return table;
  })();

  function bytesFrom(value, label) {
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      try {
        return new Uint8Array(value);
      } catch (_error) {
        throw new TypeError(`${label} must be an attached ArrayBuffer.`);
      }
    }
    throw new TypeError(`${label} must be a Uint8Array or ArrayBuffer.`);
  }

  function crc32(value) {
    const bytes = bytesFrom(value, "CRC input");
    let checksum = UINT32_MAX;
    for (let index = 0; index < bytes.length; index += 1) {
      checksum = CRC32_TABLE[(checksum ^ bytes[index]) & 0xff] ^ (checksum >>> 8);
    }
    return (checksum ^ UINT32_MAX) >>> 0;
  }

  function utf8Encode(value) {
    const bytes = [];
    for (let index = 0; index < value.length; index += 1) {
      let codePoint = value.charCodeAt(index);

      if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
        const low = value.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
          index += 1;
        } else {
          codePoint = 0xfffd;
        }
      } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
        codePoint = 0xfffd;
      }

      if (codePoint <= 0x7f) {
        bytes.push(codePoint);
      } else if (codePoint <= 0x7ff) {
        bytes.push(
          0xc0 | (codePoint >>> 6),
          0x80 | (codePoint & 0x3f)
        );
      } else if (codePoint <= 0xffff) {
        bytes.push(
          0xe0 | (codePoint >>> 12),
          0x80 | ((codePoint >>> 6) & 0x3f),
          0x80 | (codePoint & 0x3f)
        );
      } else {
        bytes.push(
          0xf0 | (codePoint >>> 18),
          0x80 | ((codePoint >>> 12) & 0x3f),
          0x80 | ((codePoint >>> 6) & 0x3f),
          0x80 | (codePoint & 0x3f)
        );
      }
    }
    return Uint8Array.from(bytes);
  }

  function validateEntryName(value, usedNames) {
    if (typeof value !== "string" || !value) {
      throw new TypeError("ZIP entry names must be non-empty strings.");
    }
    if (value.length > UINT16_MAX) {
      throw new RangeError("ZIP entry name is too long.");
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`Unsafe ZIP entry name: ${value}`);
    }
    if (value.includes("\\") || value.startsWith("/") || /^[a-z]:/i.test(value)) {
      throw new Error(`Unsafe ZIP entry name: ${value}`);
    }

    const pathParts = value.split("/");
    if (pathParts.some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Unsafe ZIP entry name: ${value}`);
    }

    const duplicateKey = typeof value.normalize === "function" ? value.normalize("NFC") : value;
    if (usedNames.has(duplicateKey)) {
      throw new Error(`Duplicate ZIP entry name: ${value}`);
    }
    usedNames.add(duplicateKey);

    const encoded = utf8Encode(value);
    if (encoded.length > UINT16_MAX) {
      throw new RangeError("UTF-8 ZIP entry name is too long.");
    }
    return encoded;
  }

  function writeUint16(target, offset, value) {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
  }

  function writeUint32(target, offset, value) {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
    target[offset + 2] = (value >>> 16) & 0xff;
    target[offset + 3] = (value >>> 24) & 0xff;
  }

  function checkedSize(value, label) {
    if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
      throw new RangeError(`${label} exceeds the non-Zip64 32-bit limit.`);
    }
    return value;
  }

  function dosDateTime(input) {
    let date;
    if (input === undefined) {
      date = new Date();
    } else {
      try {
        // This also validates Date objects originating in another realm.
        const timestamp = Date.prototype.getTime.call(input);
        date = new Date(timestamp);
      } catch (_error) {
        throw new TypeError("options.date must be a valid Date.");
      }
    }

    if (!Number.isFinite(date.getTime())) {
      throw new TypeError("options.date must be a valid Date.");
    }

    const year = Math.max(1980, Math.min(2107, date.getFullYear()));
    return {
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
    };
  }

  function createLocalHeader(name, dataSize, checksum, timestamp) {
    const record = new Uint8Array(30 + name.length);
    writeUint32(record, 0, 0x04034b50);
    writeUint16(record, 4, VERSION_NEEDED);
    writeUint16(record, 6, UTF8_FLAG);
    writeUint16(record, 8, STORED_METHOD);
    writeUint16(record, 10, timestamp.time);
    writeUint16(record, 12, timestamp.date);
    writeUint32(record, 14, checksum);
    writeUint32(record, 18, dataSize);
    writeUint32(record, 22, dataSize);
    writeUint16(record, 26, name.length);
    writeUint16(record, 28, 0);
    record.set(name, 30);
    return record;
  }

  function createCentralHeader(name, dataSize, checksum, timestamp, localOffset) {
    const record = new Uint8Array(46 + name.length);
    writeUint32(record, 0, 0x02014b50);
    writeUint16(record, 4, VERSION_NEEDED);
    writeUint16(record, 6, VERSION_NEEDED);
    writeUint16(record, 8, UTF8_FLAG);
    writeUint16(record, 10, STORED_METHOD);
    writeUint16(record, 12, timestamp.time);
    writeUint16(record, 14, timestamp.date);
    writeUint32(record, 16, checksum);
    writeUint32(record, 20, dataSize);
    writeUint32(record, 24, dataSize);
    writeUint16(record, 28, name.length);
    writeUint16(record, 30, 0);
    writeUint16(record, 32, 0);
    writeUint16(record, 34, 0);
    writeUint16(record, 36, 0);
    writeUint32(record, 38, 0);
    writeUint32(record, 42, localOffset);
    record.set(name, 46);
    return record;
  }

  function createEndRecord(entryCount, centralSize, centralOffset) {
    const record = new Uint8Array(22);
    writeUint32(record, 0, 0x06054b50);
    writeUint16(record, 4, 0);
    writeUint16(record, 6, 0);
    writeUint16(record, 8, entryCount);
    writeUint16(record, 10, entryCount);
    writeUint32(record, 12, centralSize);
    writeUint32(record, 16, centralOffset);
    writeUint16(record, 20, 0);
    return record;
  }

  function createStoredZip(entries, options) {
    if (!Array.isArray(entries)) {
      throw new TypeError("ZIP entries must be an array.");
    }
    if (entries.length > UINT16_MAX) {
      throw new RangeError("ZIP archives cannot contain more than 65535 entries without Zip64.");
    }
    if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
      throw new TypeError("ZIP options must be an object.");
    }

    const timestamp = dosDateTime(options && options.date);
    const localParts = [];
    const centralParts = [];
    const usedNames = new Set();
    let localSize = 0;
    let centralSize = 0;

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry || typeof entry !== "object") {
        throw new TypeError(`ZIP entry ${index + 1} must be an object.`);
      }

      const name = validateEntryName(entry.name, usedNames);
      const data = bytesFrom(entry.data, `ZIP entry ${index + 1} data`);
      const dataSize = checkedSize(data.byteLength, `ZIP entry ${index + 1}`);
      const checksum = crc32(data);
      const localOffset = checkedSize(localSize, "ZIP local entry offset");
      const localHeader = createLocalHeader(name, dataSize, checksum, timestamp);
      const centralHeader = createCentralHeader(name, dataSize, checksum, timestamp, localOffset);

      localSize = checkedSize(localSize + localHeader.length + dataSize, "ZIP archive size");
      centralSize = checkedSize(centralSize + centralHeader.length, "ZIP central directory size");
      localParts.push(localHeader, data);
      centralParts.push(centralHeader);
    }

    const endRecord = createEndRecord(entries.length, centralSize, localSize);
    const size = checkedSize(localSize + centralSize + endRecord.length, "ZIP archive size");
    return {
      parts: localParts.concat(centralParts, endRecord),
      size,
      entryCount: entries.length
    };
  }

  const api = Object.freeze({
    crc32,
    createStoredZip
  });

  root.ImageDownloaderArchive = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis === "object" ? globalThis : this);
