/**
 * Preload file that will be executed in the renderer process.
 * Note: This needs to be attached **prior to imports**, as imports
 * would delay the attachment till after the event has been raised.
 */
document.addEventListener('DOMContentLoaded', () => {
  injectScripts(); // eslint-disable-line @typescript-eslint/no-use-before-define
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ipcRenderer } from 'electron';
import { OutputOptions, WindowOptions } from '../../shared/src/options/model';

// Do *NOT* add 3rd-party imports here in preload (except for webpack `externals` like electron).
// They will work during development, but break in the prod build :-/ .
// Electron doc isn't explicit about that, so maybe *we*'re doing something wrong.
// At any rate, that's what we have now. If you want an import here, go ahead, but
// verify that apps built with a non-devbuild nativefier (installed from tarball) work.
// Recipe to monkey around this, assuming you git-cloned nativefier in /opt/nativefier/ :
// cd /opt/nativefier/ && rm -f nativefier-43.1.0.tgz && npm run build && npm pack && mkdir -p ~/n4310/ && cd ~/n4310/ \
//    && rm -rf ./* && npm i /opt/nativefier/nativefier-43.1.0.tgz && ./node_modules/.bin/nativefier 'google.com'
// See https://github.com/nativefier/nativefier/issues/1175
// and https://www.electronjs.org/docs/api/browser-window#new-browserwindowoptions / preload

const log = console; // since we can't have `loglevel` here in preload

export const INJECT_DIR = path.join(__dirname, '..', 'inject');

/**
 * Native notification bridge allowing renderer-level Notification APIs
 * to be routed through the main process (so we get true OS notifications
 * and can surface click / close / reply callbacks).
 */
type NotificationEventName = 'click' | 'close' | 'reply';

type NotificationListenerMap = Record<NotificationEventName, Set<EventListener>>;

interface RendererNotificationRecord {
  instance: NativefierNotification;
  listeners: NotificationListenerMap;
}

const rendererNotifications = new Map<number, RendererNotificationRecord>();
let notificationCounter = 1;
// Shared notification tracking (used by both FB notifications and title monitoring)
let lastNotificationTime = 0;
let lastWebNotification: { title: string; time: number } | null = null;

function normalizeNotificationContent(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (
    value &&
    typeof value === 'object' &&
    'props' in value &&
    value.props &&
    typeof (value as { props?: unknown }).props === 'object'
  ) {
    const props = (value as { props: { content?: unknown } }).props;
    if (Array.isArray(props.content)) {
      return props.content
        .map((contentPiece) => normalizeNotificationContent(contentPiece) ?? '')
        .join('')
        .trim();
    }
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return undefined;
}

class NativefierNotification {
  public onclick: ((event: Event) => void) | null = null;
  public onclose: ((event: Event) => void) | null = null;
  public onreply: ((event: CustomEvent<{ reply?: string }>) => void) | null =
    null;
  public readonly body?: string;
  public readonly data?: unknown;
  public readonly icon?: string;
  public readonly silent?: boolean;
  public readonly tag?: string;
  public readonly title: string;
  private readonly id: number;

  constructor(title: string, options: NotificationOptions = {}) {
    this.id = notificationCounter++;
  const normalizedTitle =
    normalizeNotificationContent(title) ?? String(title ?? '');
    const normalizedBody = normalizeNotificationContent(options.body);

    this.title = normalizedTitle;
    this.body = normalizedBody;
    this.data = options.data;
    this.icon = options.icon as string | undefined;
    this.silent =
      typeof options.silent === 'boolean' ? options.silent : undefined;
    this.tag = options.tag;

    rendererNotifications.set(this.id, {
      instance: this,
      listeners: {
        click: new Set<EventListener>(),
        close: new Set<EventListener>(),
        reply: new Set<EventListener>(),
      },
    });

    const now = Date.now();
    const shouldSend =
      !lastWebNotification ||
      lastWebNotification.title !== normalizedTitle ||
      now - lastWebNotification.time >= 1000;

    if (shouldSend) {
      lastWebNotification = { title: normalizedTitle, time: now };
      lastNotificationTime = now;
      ipcRenderer.send('notification', {
        id: this.id,
        title: normalizedTitle,
        options: {
          ...options,
          body: normalizedBody,
        },
      });
    }
  }

  close(): void {
    ipcRenderer.send('notification-close', { id: this.id });
    emitNotificationEvent(this.id, 'close');
  }

  addEventListener(event: string, handler: EventListener): void {
    const record = rendererNotifications.get(this.id);
    const listenerSet = record?.listeners[event as NotificationEventName];
    listenerSet?.add(handler);
  }

  removeEventListener(event: string, handler: EventListener): void {
    const record = rendererNotifications.get(this.id);
    const listenerSet = record?.listeners[event as NotificationEventName];
    listenerSet?.delete(handler);
  }

  dispatchEvent(event: Event): boolean {
    emitNotificationEvent(this.id, event.type as NotificationEventName, event);
    return true;
  }

  static requestPermission(): Promise<NotificationPermission> {
    return Promise.resolve('granted');
  }

  static get permission(): NotificationPermission {
    return 'granted';
  }
}

function emitNotificationEvent(
  id: number,
  eventName: NotificationEventName,
  existingEvent?: Event,
  detail?: { reply?: string },
): void {
  const record = rendererNotifications.get(id);
  if (!record) {
    return;
  }

  const event =
    existingEvent ??
    (eventName === 'reply'
      ? (new CustomEvent('reply', { detail }) as Event)
      : new Event(eventName));

  const handler =
    eventName === 'click'
      ? record.instance.onclick
      : eventName === 'close'
        ? record.instance.onclose
        : record.instance.onreply;
  handler?.(event as CustomEvent<{ reply?: string }>);

  record.listeners[eventName].forEach((listener) => {
    try {
      listener(event);
    } catch (err) {
      log.error('Notification listener error', err);
    }
  });

  if (eventName === 'close') {
    rendererNotifications.delete(id);
  }
}

function overrideNotification(): void {
  if (!window.Notification) {
    log.error('Notification is not available in this renderer');
    return;
  }

  // @ts-expect-error assignment between different constructor signatures
  window.Notification = NativefierNotification;
  Object.assign(window, { notification: NativefierNotification });
}

overrideNotification();

ipcRenderer.on(
  'notification-event',
  (_event, payload: { id: number; event: NotificationEventName; reply?: string }) => {
    emitNotificationEvent(payload.id, payload.event, undefined, {
      reply: payload.reply,
    });
  },
);

async function getDisplayMedia(
  sourceId: number | string,
): Promise<MediaStream> {
  type OriginalVideoPropertyType = boolean | MediaTrackConstraints | undefined;
  if (!window?.navigator?.mediaDevices) {
    throw Error('window.navigator.mediaDevices is not present');
  }
  // Electron supports an outdated specification for mediaDevices,
  // see https://www.electronjs.org/docs/latest/api/desktop-capturer/
  const stream = await window.navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
      },
    } as unknown as OriginalVideoPropertyType,
  });

  return stream;
}

function setupScreenSharePickerStyles(id: string): void {
  const screenShareStyles = document.createElement('style');
  screenShareStyles.id = id;
  screenShareStyles.innerHTML = `
  .desktop-capturer-selection {
    --overlay-color: hsla(0, 0%, 11.8%, 0.75);
    --highlight-color: highlight;
    --text-content-color: #fff;
    --selection-button-color: hsl(180, 1.3%, 14.7%);
  }
  .desktop-capturer-selection {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100vh;
    background: var(--overlay-color);
    color: var(--text-content-color);
    z-index: 10000000;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .desktop-capturer-selection__close {
    -moz-appearance: none;
    -webkit-appearance: none;
    appearance: none;
    padding: 1rem;
    color: inherit;
    position: absolute;
    left: 1rem;
    top: 1rem;
    cursor: pointer;
  }
  .desktop-capturer-selection__scroller {
    width: 100%;
    max-height: 100vh;
    overflow-y: auto;
  }
  .desktop-capturer-selection__list {
    max-width: calc(100% - 100px);
    margin: 50px;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    list-style: none;
    overflow: hidden;
    justify-content: center;
  }
  .desktop-capturer-selection__item {
    display: flex;
    margin: 4px;
  }
  .desktop-capturer-selection__btn {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 145px;
    margin: 0;
    border: 0;
    border-radius: 3px;
    padding: 4px;
    background: var(--selection-button-color);
    text-align: left;
    transition: background-color .15s, box-shadow .15s;
  }
  .desktop-capturer-selection__btn:hover,
  .desktop-capturer-selection__btn:focus {
    background: var(--highlight-color);
  }
  .desktop-capturer-selection__thumbnail {
    width: 100%;
    height: 81px;
    object-fit: cover;
  }
  .desktop-capturer-selection__name {
    margin: 6px 0 6px;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }
  @media (prefers-color-scheme: light) {
    .desktop-capturer-selection {
      --overlay-color: hsla(0, 0%, 90.2%, 0.75);
      --text-content-color: hsl(0, 0%, 12.9%);
      --selection-button-color: hsl(180, 1.3%, 85.3%);
    }
  }`;
  document.head.appendChild(screenShareStyles);
}

function setupScreenSharePickerElement(
  id: string,
  sources: Electron.DesktopCapturerSource[],
): void {
  const selectionElem = document.createElement('div');
  selectionElem.classList.add('desktop-capturer-selection');
  selectionElem.id = id;
  selectionElem.innerHTML = `
    <button class="desktop-capturer-selection__close" id="${id}-close" aria-label="Close screen share picker" type="button">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32">
      <path fill="currentColor" d="m12 10.586 4.95-4.95 1.414 1.414-4.95 4.95 4.95 4.95-1.414 1.414-4.95-4.95-4.95 4.95-1.414-1.414 4.95-4.95-4.95-4.95L7.05 5.636z"/>
      </svg>
    </button>
    <div class="desktop-capturer-selection__scroller">
      <ul class="desktop-capturer-selection__list">
        ${sources
          .map(
            ({ id, name, thumbnail }) => `
          <li class="desktop-capturer-selection__item">
            <button class="desktop-capturer-selection__btn" data-id="${id}" title="${name}">
              <img class="desktop-capturer-selection__thumbnail" src="${thumbnail.toDataURL()}" />
              <span class="desktop-capturer-selection__name">${name}</span>
            </button>
          </li>
        `,
          )
          .join('')}
      </ul>
    </div>
    `;
  document.body.appendChild(selectionElem);
}

function setupScreenSharePicker(
  resolve: (value: MediaStream | PromiseLike<MediaStream>) => void,
  reject: (reason?: unknown) => void,
  sources: Electron.DesktopCapturerSource[],
): void {
  const baseElementsId = 'native-screen-share-picker';
  const pickerStylesElementId = baseElementsId + '-styles';

  setupScreenSharePickerElement(baseElementsId, sources);
  setupScreenSharePickerStyles(pickerStylesElementId);

  const clearElements = (): void => {
    document.getElementById(pickerStylesElementId)?.remove();
    document.getElementById(baseElementsId)?.remove();
  };

  document
    .getElementById(`${baseElementsId}-close`)
    ?.addEventListener('click', () => {
      clearElements();
      reject('Screen share was cancelled by the user.');
    });

  document
    .querySelectorAll('.desktop-capturer-selection__btn')
    .forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-id');
        if (!id) {
          log.error("Couldn't find `data-id` of element");
          clearElements();
          return;
        }
        const source = sources.find((source) => source.id === id);
        if (!source) {
          log.error(`Source with id "${id}" does not exist`);
          clearElements();
          return;
        }

        getDisplayMedia(source.id)
          .then((stream) => {
            resolve(stream);
          })
          .catch((err) => {
            log.error('Error selecting desktop capture source:', err);
            reject(err);
          })
          .finally(() => {
            clearElements();
          });
      });
    });
}

function setDisplayMediaPromise(): void {
  // Since no implementation for `getDisplayMedia` exists in Electron we write our own.
  if (!window?.navigator?.mediaDevices) {
    return;
  }
  window.navigator.mediaDevices.getDisplayMedia = (): Promise<MediaStream> => {
    return new Promise((resolve, reject) => {
      const sources = ipcRenderer.invoke(
        'desktop-capturer-get-sources',
      ) as Promise<Electron.DesktopCapturerSource[]>;
      sources
        .then(async (sources) => {
          if (isWayland()) {
            // No documentation is provided wether the first element is always PipeWire-picked or not
            // i.e. maybe it's not deterministic, we are only taking a guess here.
            const stream = await getDisplayMedia(sources[0].id);
            resolve(stream);
          } else {
            setupScreenSharePicker(resolve, reject, sources);
          }
        })
        .catch((err) => {
          reject(err);
        });
    });
  };
}

function injectScripts(): void {
  const needToInject = fs.existsSync(INJECT_DIR);
  if (!needToInject) {
    return;
  }
  // Dynamically require scripts
  try {
    const jsFiles = fs
      .readdirSync(INJECT_DIR, { withFileTypes: true })
      .filter(
        (injectFile) => injectFile.isFile() && injectFile.name.endsWith('.js'),
      )
      .map((jsFileStat) => path.join('..', 'inject', jsFileStat.name));
    for (const jsFile of jsFiles) {
      log.debug('Injecting JS file', jsFile);
      require(jsFile);
    }
  } catch (err: unknown) {
    log.error('Error encoutered injecting JS files', err);
  }
}

// Detect when Facebook plays a notification sound
let lastNotifiedSoundTime = 0;
let audioNotificationsEnabled = false; // Default to disabled; opt-in via flag

// Intercept Audio constructor to detect sound playback
const OriginalAudio = window.Audio;
(window as any).Audio = function(...args: any[]) {
  const audio = new OriginalAudio(...args);

  audio.addEventListener('play', () => {
    if (!audioNotificationsEnabled) return;

    const now = Date.now();
    // Only notify if more than 2 seconds since last notification
    if ((now - lastNotificationTime) > 2000 && (now - lastNotifiedSoundTime) > 1000) {
      new window.Notification('New Notification', {
        body: 'You have a new notification',
      });
      lastNotifiedSoundTime = now;
      lastNotificationTime = now;
    }
  });

  return audio;
};

// Monitor existing and new audio elements in the DOM
const setupAudioMonitoring = () => {
  const handleAudioPlay = () => {
    if (!audioNotificationsEnabled) return;

    const now = Date.now();
    if ((now - lastNotificationTime) > 2000 && (now - lastNotifiedSoundTime) > 1000) {
      new window.Notification('New Notification', {
        body: 'You have a new notification',
      });
      lastNotifiedSoundTime = now;
      lastNotificationTime = now;
    }
  };

  // Monitor existing audio elements
  document.querySelectorAll('audio').forEach((audio) => {
    audio.addEventListener('play', handleAudioPlay);
  });

  // Watch for new audio elements being added to DOM
  const audioObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeName === 'AUDIO') {
          (node as HTMLAudioElement).addEventListener('play', handleAudioPlay);
        } else if ((node as Element).querySelector?.('audio')) {
          (node as Element).querySelectorAll('audio').forEach((audio) => {
            audio.addEventListener('play', handleAudioPlay);
          });
        }
      });
    });
  });

  audioObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
};

// Setup when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupAudioMonitoring);
} else {
  setupAudioMonitoring();
}

// Monitor Web Audio API
if (window.AudioContext || (window as any).webkitAudioContext) {
  const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
  const originalCreateBufferSource = AudioContext.prototype.createBufferSource;

  AudioContext.prototype.createBufferSource = function() {
    const source = originalCreateBufferSource.call(this);
    const originalStart = source.start;

    source.start = function(when?: number, offset?: number, duration?: number) {
      if (audioNotificationsEnabled) {
        const now = Date.now();
        if ((now - lastNotificationTime) > 2000 && (now - lastNotifiedSoundTime) > 1000) {
          new window.Notification('Notification', {
            body: 'You have a new message',
          });
          lastNotifiedSoundTime = now;
          lastNotificationTime = now;
        }
      }
      return originalStart.call(this, when, offset, duration);
    };

    return source;
  };
}

setDisplayMediaPromise();

ipcRenderer.on('params', (event, message: string) => {
  log.debug('ipcRenderer.params', { event, message });
  const windowOptions: unknown = JSON.parse(message) as WindowOptions;
  log.info('nativefier.json', windowOptions);

  // Update audio notifications setting from window options
  if (
    windowOptions &&
    typeof windowOptions === 'object' &&
    'audioNotifications' in windowOptions
  ) {
    audioNotificationsEnabled = Boolean(
      (windowOptions as Record<string, unknown>).audioNotifications,
    );
  }
});

ipcRenderer.on('debug', (event, message: string) => {
  log.debug('ipcRenderer.debug', { event, message });
});

// Copy-pastaed as unable to get imports to work in preload.
// If modifying, update also app/src/helpers/helpers.ts
function isWayland(): boolean {
  return (
    isLinux() &&
    (Boolean(process.env.WAYLAND_DISPLAY) ||
      process.env.XDG_SESSION_TYPE === 'wayland')
  );
}

function isLinux(): boolean {
  return os.platform() === 'linux';
}
