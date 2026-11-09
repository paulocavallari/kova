import { setState, useStore } from '../lib/store';
import { useT } from '../i18n';
import { Switch } from './ui';

export function MonthlyToggle() {
  const s = useStore();
  const { t } = useT();
  const on = s.settings.monthlyCardView !== false;
  return (
    <div className="setting">
      <div className="grow">
        <div className="t">{t('monthlyView')}</div>
      </div>
      <Switch
        on={on}
        label={t('monthlyView')}
        onChange={(v) => setState((st) => ({ ...st, settings: { ...st.settings, monthlyCardView: v } }))}
      />
    </div>
  );
}
