// Bridge to native features when running inside the iOS/Android app (Capacitor).
// In a normal browser every function here is a harmless no-op, so the PWA keeps working.
// Plugins are reached through the global `Capacitor` object the native shell injects,
// which keeps the app free of a bundler.

const Cap = globalThis.Capacitor;
export const isNative = Boolean(Cap?.isNativePlatform?.());
export const platform = Cap?.getPlatform?.() ?? 'web';

const plugin = (name) => (isNative ? Cap.registerPlugin(name) : null);
const Preferences = plugin('Preferences');
const LocalNotifications = plugin('LocalNotifications');
const Share = plugin('Share');
const Filesystem = plugin('Filesystem');

// ---------- durable storage ----------
// iOS may evict WebView localStorage under storage pressure; Preferences
// (UserDefaults / SharedPreferences) is not evicted.
export async function getStored(key) {
  if (!Preferences) return null;
  try {
    return (await Preferences.get({ key })).value ?? null;
  } catch {
    return null;
  }
}

export function setStored(key, value) {
  return Preferences?.set({ key, value }).catch(() => {});
}

// ---------- sharing & files ----------
export async function shareText(title, text) {
  if (!Share) return false;
  try {
    await Share.share({ title, text, dialogTitle: title });
  } catch { /* user cancelled */ }
  return true;
}

/** Writes a file to the app cache and opens the share sheet (save to Files, Drive, email…). */
export async function shareFile(filename, text) {
  if (!Filesystem || !Share) return false;
  const { uri } = await Filesystem.writeFile({ path: filename, data: text, directory: 'CACHE', encoding: 'utf8' });
  try {
    await Share.share({ title: filename, files: [uri], dialogTitle: filename });
  } catch { /* user cancelled */ }
  return true;
}

// ---------- reminders ----------
const MAX_REMINDERS = 14;
const ID_BASE = 1000;

export async function notificationsAllowed(prompt = false) {
  if (!LocalNotifications) return false;
  try {
    let { display } = await LocalNotifications.checkPermissions();
    if (display !== 'granted' && prompt) ({ display } = await LocalNotifications.requestPermissions());
    return display === 'granted';
  } catch {
    return false;
  }
}

/** Replaces all scheduled reminders with `plan` ([{ date: 'YYYY-MM-DD', names: [...] }]). */
export async function scheduleReminders(plan, hour) {
  if (!LocalNotifications) return;
  try {
    const { notifications } = await LocalNotifications.getPending();
    if (notifications.length) {
      await LocalNotifications.cancel({ notifications: notifications.map((n) => ({ id: n.id })) });
    }
    if (!plan.length || !(await notificationsAllowed())) return;
    const now = Date.now();
    const list = plan
      .map((p, i) => {
        const [y, m, d] = p.date.split('-').map(Number);
        const at = new Date(y, m - 1, d, hour, 0, 0);
        const shown = p.names.slice(0, 4).join(', ') + (p.names.length > 4 ? ` +${p.names.length - 4} more` : '');
        return {
          id: ID_BASE + i,
          title: p.names.length === 1 ? `Cook the ${p.names[0].toLowerCase()} soon` : 'Cook these soon',
          body: p.names.length === 1
            ? 'It’s at its best now. Use it before it goes in the bin 🥬'
            : `${shown}. Use them before they go in the bin 🥬`,
          schedule: { at, allowWhileIdle: true },
        };
      })
      .filter((n) => n.schedule.at.getTime() > now)
      .slice(0, MAX_REMINDERS);
    if (list.length) await LocalNotifications.schedule({ notifications: list });
  } catch { /* reminders are best-effort */ }
}

export function onReminderTap(fn) {
  LocalNotifications?.addListener('localNotificationActionPerformed', fn);
}
