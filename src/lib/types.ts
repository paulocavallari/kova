export type Cents = number;
export type Kind = 'expense' | 'income';
export interface Account {
  id: string;
  name: string;
  icon: string;
  color: string;
  currency: string;
  initial: Cents; // opening balance in account currency
  includeInTotal: boolean;
  archived: boolean;
  order: number;
  note?: string;
  pluggy?: { apiId: string; accountId: string; type: string; itemId?: string; forecastGap?: boolean; lastAutoName?: string; nameCustomized?: boolean; bills?: PluggyBillsCache };
}
export interface PluggyBill {
  id: string;
  dueDate: string;
  amountCents: number;
  currency: string;
}
export interface PluggyBillsCache {
  items: PluggyBill[];
  fetchedAt: string;
  status: 'fresh' | 'stale' | 'error';
}
export interface Category {
  id: string;
  name: string;
  kind: Kind;
  icon: string;
  color: string;
  budget?: Cents; // monthly limit in base currency
  essential?: boolean; // undefined = guessed from the name (reports)
  archived: boolean;
  order: number;
}
export interface Tx {
  id: string;
  kind: Kind;
  accountId: string;
  categoryId: string;
  amount: Cents; // in account currency (positive)
  base: Cents; // in base currency at the time of the transaction
  date: string; // YYYY-MM-DD
  note: string;
  tags: string[];
  created: string;
  repeat?: Repeat; // recurring series: next occurrence is created automatically
  series?: string;
  done?: boolean; // future-dated but already paid/received: counts in the balance now
  remind?: number; // days before the due date to notify (recurring bills); undefined = no reminder
  attachments?: Attachment[];
  src?: 'notif'; // created from a bank notification
  nid?: string; // id of that detection
  pluggy?: { apiId: string; txId: string; op: string; billId?: string; billForecastDate?: string; billCents?: number; installmentNumber?: number; totalInstallments?: number; purchaseDate?: string };
}
export interface Attachment {
  id: string; // key of the file in IndexedDB
  name: string;
  type: string;
  size: number;
}
export type Repeat = 'weekly' | 'monthly' | 'yearly';
export interface Transfer {
  id: string;
  from: string;
  to: string;
  fromAmount: Cents;
  toAmount: Cents;
  date: string;
  note: string;
  created: string;
  pluggy?: { fromApiId: string; fromTxId: string; fromDate: string; toApiId: string; toTxId: string; toDate: string; kind?: 'regular' | 'card' | 'invest' };
}
export type Theme = 'system' | 'light' | 'dark';
export type Lang = 'auto' | 'en' | 'pt';
export interface Settings {
  name: string;
  baseCurrency: string;
  rates: Record<string, number>; // 1 unit of currency = N base
  ratesUpdated?: string;
  theme: Theme;
  lang: Lang;
  hideBalance: boolean;
  weekStart: 0 | 1;
  onboarded: boolean;
  autoBackup: boolean;
  lastBackup?: string;
  billReminders: boolean;
  lastBackupTxs?: number;
  pinHash?: string; // app lock: sha-256(salt + pin)
  pinSalt?: string;
  pinLen?: number;
  biometric?: boolean;
  catRows?: number; // category rows shown in the transaction editor (0 = all, default 2)
  widgetHide?: boolean; // show •••• instead of values on the home-screen widget
  notif?: NotifSettings;
  statusNotif?: boolean; // ongoing notification with the month total
  shortcutsOn?: boolean; // shortcut chips on Home + ⚡ in the editor (default on)
  haptics?: boolean; // vibrate on taps (default on)
  showTags?: boolean; // tags field in the transaction editor (default on)
  monthlyCardView?: boolean; // cards by invoice due this month and monthly result (default on)
}
export interface State {
  version: 1;
  accounts: Account[];
  categories: Category[];
  txs: Tx[];
  transfers: Transfer[];
  shortcuts?: Shortcut[];
  merchants?: Record<string, Merchant>; // learned from bank notifications: 'kind|merchant key' → choice
  notifBlocked?: Record<string, string[]>; // per app: message shapes that are not transactions
  settings: Settings;
  pluggy?: PluggyConn[]; // independent "Meu Pluggy" API connections (empty on legacy states)
}
export interface PluggyConn {
  id: string;
  name: string;
  clientId: string;
  clientSecret: string;
  itemIds: string[];
  baseUrl: string;
  enabled: boolean;
  auto: boolean; // automatic 24h / new-data updates
  lastSyncAt?: string;
  lastStatus?: 'ok' | 'error';
  lastError?: string;
  itemUpdatedAt?: Record<string, string>; // lastUpdatedAt seen per item after a successful sync
  lastProbeAt?: string; // cooldown of the light item probe
  lastCount?: number; // imported transactions in the last sync
  accountSync?: Record<string, string>; // per account: last successful dateFrom checkpoint
  pending?: PluggyPendingLeg[]; // unpaired card/investment legs kept only for a future pair
}
export interface PluggyPendingLeg {
  apiId: string;
  txId: string;
  accountId: string;
  currency: string;
  cents: number;
  date: string;
  op: string;
  desc: string;
  role: 'card' | 'invest';
  dir: 'out' | 'in';
}
/** One-tap launch preset ("Padaria · Café · N26"). */
export interface Shortcut {
  id: string;
  kind: Kind;
  categoryId: string;
  accountId: string;
  amount?: Cents; // fixed amount, optional
  note: string;
}
export interface Merchant { cat: string; note: string; acc: string; n: number; name?: string }
export type NotifMode = 'ask' | 'smart' | 'auto';
export interface NotifApp { on: boolean; acc: string; mode: NotifMode; label: string }
export interface NotifSettings { on: boolean; apps: Record<string, NotifApp> }
