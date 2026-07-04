import {
  css,
  customElement,
  html,
  query,
  RorschachBase,
  state,
  StoreController,
  type MediaItem
} from '@rorschach/webkit';

@customElement('r-chat-input')
export class RChatInput extends RorschachBase {
  @state() private pendingMedia: MediaItem[] = [];
  @state() private isRecording = false;

  private _isConnected = new StoreController(this, ['shell', 'isConnected']);
  private _isWaiting = new StoreController(this, ['shell', 'isWaiting']);

  @query('#input') private inputEl!: HTMLTextAreaElement;
  @query('#file-input') private fileInputEl!: HTMLInputElement;

  private _mediaRecorder: any = null;
  private _audioCtx: AudioContext | null = null;
  private _recordingStream: MediaStream | null = null;

  override createRenderRoot() {
    return this;
  }

  getPending() {
    return {
      images: this.pendingMedia.filter(m => m.kind === 'image').map(m => m.data),
      audio: this.pendingMedia.find(m => m.kind === 'audio')?.data ?? null,
      pdfs: this.pendingMedia.filter(m => m.kind === 'pdf'),
    };
  }

  clearPending() {
    this.pendingMedia = [];
  }

  /** Focus signal — increment to request focus. */
  @state() focusSignal = 0;

  override updated(changedProperties: Map<string | symbol, unknown>) {
    if (changedProperties.has('focusSignal') && this.focusSignal > 0) {
      this.inputEl?.focus();
    }
  }

  private _handleInput() {
    const input = this.inputEl;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 150) + 'px';
  }

  private _handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._submit();
    }
  }

  private _submit() {
    const text = this.inputEl.value.trim();
    const attachments = this.pendingMedia.map(m =>
      m.kind === 'pdf' ? { kind: 'pdf', data: m.data, name: m.name } : { kind: m.kind, data: m.data }
    );

    if (!text && attachments.length === 0) return;

    this.dispatchEvent(new CustomEvent('chat-submit', {
      bubbles: true,
      composed: true,
      detail: { text, attachments },
    }));

    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    this.clearPending();
  }

  private async _handleFileChange() {
    const files = Array.from(this.fileInputEl.files ?? []);
    for (const file of files) {
      const dataUrl = await this._readFileAsDataUrl(file);
      if (file.type.startsWith('image/')) {
        this.pendingMedia = [...this.pendingMedia, { kind: 'image', data: dataUrl }];
      } else if (file.type.startsWith('audio/') || /\.(mp3|wav)$/i.test(file.name)) {
        this.pendingMedia = [...this.pendingMedia.filter(m => m.kind !== 'audio'), { kind: 'audio', data: dataUrl }];
      } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        this.pendingMedia = [...this.pendingMedia, { kind: 'pdf', data: dataUrl, name: file.name }];
      }
    }
    this.fileInputEl.value = '';
  }

  private _removeMedia(index: number) {
    this.pendingMedia = this.pendingMedia.filter((_, i) => i !== index);
  }

  private async _toggleRecording() {
    if (this.isRecording) {
      this._mediaRecorder?.stop();
      return;
    }

    try {
      this._recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return;
    }

    this._audioCtx = new AudioContext({ sampleRate: 16000 });
    await this._audioCtx.audioWorklet.addModule('worklets/recorder-processor.js');

    const source = this._audioCtx.createMediaStreamSource(this._recordingStream);
    const workletNode = new AudioWorkletNode(this._audioCtx, 'recorder-processor');
    const samples: Float32Array[] = [];

    workletNode.port.onmessage = (e) => { samples.push(e.data); };
    source.connect(workletNode);
    this.isRecording = true;

    this._mediaRecorder = {
      stop: () => {
        this.isRecording = false;
        workletNode.disconnect();
        source.disconnect();
        this._audioCtx?.close();
        this._recordingStream?.getTracks().forEach(t => t.stop());

        const totalLen = samples.reduce((n, s) => n + s.length, 0);
        const pcm = new Int16Array(totalLen);
        let offset = 0;
        for (const chunk of samples) {
          for (let i = 0; i < chunk.length; i++) {
            const val = chunk[i] ?? 0;
            pcm[offset++] = Math.max(-32768, Math.min(32767, val * 32768));
          }
        }
        const wav = this._pcm16ToWav(pcm, 16000);
        const blob = new Blob([wav], { type: 'audio/wav' });
        const reader = new FileReader();
        reader.onload = () => {
          this.pendingMedia = [
            ...this.pendingMedia.filter(m => m.kind !== 'audio'),
            { kind: 'audio', data: reader.result as string },
          ];
        };
        reader.readAsDataURL(blob);
      },
    };
  }

  private _readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  private _pcm16ToWav(pcm: Int16Array, sampleRate: number) {
    const dataBytes = pcm.buffer;
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const channels = 1;
    const byteRate = sampleRate * channels * 2;
    const dataSize = dataBytes.byteLength;

    const writeStr = (offset: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    const out = new Uint8Array(44 + dataSize);
    out.set(new Uint8Array(header), 0);
    out.set(new Uint8Array(dataBytes), 44);
    return out;
  }

  override render() {
    const disabled = !this._isConnected.value || this._isWaiting.value;

    return html`
      <div class="input-area">
        <r-media-previews
          .items=${this.pendingMedia}
          @media-remove=${(e: CustomEvent<{ index: number }>) => this._removeMedia(e.detail.index)}
        ></r-media-previews>
        <form id="chat-form" @submit=${(e: Event) => { e.preventDefault(); this._submit(); }}>
          <input type="file" id="file-input" accept="image/*,audio/*,.mp3,.wav,application/pdf,.pdf" multiple style="display:none" @change=${this._handleFileChange}>
          <button type="button" id="attach-btn" aria-label="Attach file" @click=${() => this.fileInputEl.click()}>
            <r-icon name="attach"></r-icon>
          </button>
          <button type="button" id="mic-btn" class="${this.isRecording ? 'recording' : ''}" aria-label="Record audio" @click=${this._toggleRecording}>
            <r-icon name="mic"></r-icon>
          </button>
          <textarea
            id="input"
            placeholder="Message…"
            autocomplete="off"
            rows="1"
            ?disabled=${disabled}
            @input=${this._handleInput}
            @keydown=${this._handleKeydown}
          ></textarea>
          <button type="submit" id="send" ?disabled=${disabled} aria-label="Send">
            <r-icon name="send"></r-icon>
          </button>
        </form>
        <p class="input-hint">Enter to send &nbsp;·&nbsp; Shift+Enter for new line</p>
      </div>
    `;
  }
}

