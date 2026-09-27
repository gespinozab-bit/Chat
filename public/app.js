import { createSseParser } from './sse-parser.js';

const form = document.querySelector('#generation-form');
const messageInput = document.querySelector('#message');
const generateButton = document.querySelector('#generate');
const stopButton = document.querySelector('#stop');
const status = document.querySelector('#status');
const responseElement = document.querySelector('#response');
const SAFE_ERROR = 'No fue posible generar la respuesta. Inténtalo nuevamente.';
let activeController = null;

function setStatus(label, state) {
  status.textContent = label;
  status.dataset.state = state;
}

stopButton.disabled = true;
stopButton.addEventListener('click', () => {
  if (!activeController) return;
  const controller = activeController;
  activeController = null;
  controller.abort();
  setStatus('Interrumpido', 'interrupted');
  generateButton.disabled = false;
  stopButton.disabled = true;
});
messageInput.addEventListener('input', () => messageInput.setCustomValidity(''));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (activeController) return;
  const message = messageInput.value.trim().replace(/\s+/g, ' ');
  if (!message || message.length > 2000) {
    messageInput.setCustomValidity('Escribe un mensaje de entre 1 y 2000 caracteres.');
    messageInput.reportValidity();
    return;
  }

  const controller = new AbortController();
  activeController = controller;
  const isCurrent = () => activeController === controller;
  responseElement.textContent = '';
  generateButton.disabled = true;
  stopButton.disabled = false;
  setStatus('Esperando', 'waiting');
  let reader;
  let completed = false;

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });
    if (!isCurrent()) return;
    if (!response.ok || !response.body ||
        !response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error(SAFE_ERROR);
    }

    const parser = createSseParser((eventName, data) => {
      if (!isCurrent() || completed) return;
      if (eventName === 'error') throw new Error(SAFE_ERROR);
      if (eventName === 'status' && data.status === 'waiting') {
        setStatus('Esperando', 'waiting');
      } else if (eventName === 'status' && data.status === 'generating') {
        setStatus('Generando', 'generating');
      } else if (eventName === 'content') {
        if (typeof data.delta !== 'string') throw new Error(SAFE_ERROR);
        // Append each delta as text, never as HTML or a completed response.
        responseElement.append(document.createTextNode(data.delta));
      } else if (eventName === 'completed' && data.status === 'completed') {
        completed = true;
        setStatus('Completado', 'completed');
        activeController = null;
        generateButton.disabled = false;
        stopButton.disabled = true;
      }
    });

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (isCurrent() && !completed) {
      const { value, done } = await reader.read();
      if (!isCurrent()) return;
      if (done) {
        parser.push(decoder.decode(), true);
        break;
      }
      parser.push(decoder.decode(value, { stream: true }));
    }
    if (isCurrent() && !completed) throw new Error(SAFE_ERROR);
  } catch (error) {
    if (isCurrent()) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        setStatus('Interrumpido', 'interrupted');
      } else {
        setStatus(`Error: ${SAFE_ERROR}`, 'error');
      }
    }
  } finally {
    if (!completed) controller.abort();
    if (isCurrent()) {
      activeController = null;
      generateButton.disabled = false;
      stopButton.disabled = true;
    }
    // Release the HTTP body even on malformed events or transport failures.
    if (reader) {
      try { await reader.cancel(); } catch { /* Already closed or aborted. */ }
    }
    reader?.releaseLock();
  }
});
