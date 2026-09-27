export function createSseParser(onEvent) {
  let buffer = '';
  let eventName = 'message';
  let dataLines = [];

  function readLine(line) {
    if (line === '') {
      if (dataLines.length) onEvent(eventName, JSON.parse(dataLines.join('\n')));
      eventName = 'message';
      dataLines = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    if (field === 'data') dataLines.push(value);
  }

  return {
    push(text, final = false) {
      buffer += text;
      let start = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const char = buffer[index];
        if (char !== '\r' && char !== '\n') continue;
        // A CR at the chunk boundary may be the first half of CRLF.
        if (char === '\r' && index === buffer.length - 1 && !final) break;
        readLine(buffer.slice(start, index));
        if (char === '\r' && buffer[index + 1] === '\n') index += 1;
        start = index + 1;
      }
      buffer = buffer.slice(start);
    },
  };
}
