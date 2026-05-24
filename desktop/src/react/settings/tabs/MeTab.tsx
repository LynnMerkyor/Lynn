import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { loadSettingsConfig } from '../actions';
import styles from '../Settings.module.css';

export function MeTab() {
  const { settingsConfig, userAvatarUrl, showToast } = useSettingsStore();
  const [userName, setUserName] = useState('');
  const [userProfile, setUserProfile] = useState('');

  useEffect(() => {
    if (settingsConfig) {
      setUserName(settingsConfig.user?.name || '');
      setUserProfile(settingsConfig._userProfile || '');
    }
  }, [settingsConfig]);

  const save = async () => {
    const store = useSettingsStore.getState();
    try {
      const partial: { user?: { name: string } } = {};
      if (userName && userName !== (settingsConfig?.user?.name || '')) {
        partial.user = { name: userName };
      }
      const profileChanged = userProfile !== (settingsConfig?._userProfile || '');

      if (!Object.keys(partial).length && !profileChanged) {
        showToast(t('settings.noChanges'), 'success');
        return;
      }

      const requests: Promise<Response>[] = [];
      if (Object.keys(partial).length) {
        requests.push(hanaFetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(partial),
        }));
      }
      if (profileChanged) {
        requests.push(hanaFetch('/api/user-profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: userProfile }),
        }));
      }

      const results = await Promise.all(requests);
      for (const res of results) {
        const data = await res.json();
        if (data.error) throw new Error(data.error);
      }

      showToast(t('settings.saved'), 'success');
      if (partial?.user?.name) store.set({ userName: partial.user.name });

      await loadSettingsConfig();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const handleAvatarClick = () => {
    // eslint-disable-next-line no-restricted-syntax -- ephemeral file picker, not part of React tree
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.addEventListener('change', () => {
      if (input.files?.[0]) {
        // Dispatch to CropOverlay
        window.dispatchEvent(new CustomEvent('hana-open-cropper', {
          detail: { role: 'user', file: input.files[0] },
        }));
      }
    });
    input.click();
  };

  const { set: setStore } = useSettingsStore();

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="me">
      {/* #16: top-level default-provider quick link — was buried under Providers tab */}
      <div
        style={{
          margin: '0 0 16px 0',
          padding: '10px 12px',
          background: 'rgba(99, 102, 241, 0.06)',
          border: '1px solid rgba(99, 102, 241, 0.18)',
          borderRadius: 8,
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span style={{ opacity: 0.85 }}>
          {t('settings.me.defaultProviderHint') || 'Switch between local 9B and cloud providers in one click.'}
        </span>
        <button
          type="button"
          onClick={() => setStore({ activeTab: 'providers' })}
          style={{
            padding: '4px 12px',
            background: 'rgba(99, 102, 241, 0.95)',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            fontSize: 12,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {t('settings.me.openProviders') || 'Open Providers →'}
        </button>
      </div>

      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.me.title')}</h2>

        <div className={styles['settings-avatar-center']}>
          <div className={styles['avatar-upload']} onClick={handleAvatarClick} title="">
            {userAvatarUrl ? (
              <img
                key={userAvatarUrl}
                className={styles['avatar-preview']}
                src={userAvatarUrl}
                draggable={false}
              />
            ) : (
              <div className={`${styles['avatar-preview']} ${styles['avatar-preview-emoji']}`}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </div>
            )}
            <div className={styles['avatar-upload-overlay']}>{t('settings.me.changeAvatar')}</div>
          </div>
        </div>

        <div className={`${styles['settings-field']} ${styles['settings-field-center']}`}>
          <span className={styles['settings-field-hint']}>{t('settings.me.userNameHint')}</span>
          <input
            className={styles['settings-input']}
            type="text"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
          />
        </div>

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{t('settings.me.userProfile')}</label>
          <textarea
            className={styles['settings-textarea']}
            rows={8}
            spellCheck={false}
            value={userProfile}
            onChange={(e) => setUserProfile(e.target.value)}
          />
          <span className={styles['settings-field-hint']}>{t('settings.me.userProfileHint')}</span>
        </div>
      </section>

      <div className={styles['settings-section-footer']}>
        <button className={styles['settings-save-btn-sm']} onClick={save}>
          {t('settings.save')}
        </button>
      </div>
    </div>
  );
}
