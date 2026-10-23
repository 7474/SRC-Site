// ヘッダのアカウントのメニュー（<details>）を、外を押すか Esc で閉じる。JavaScript が無くても開閉はできる
(() => {
  const account = document.querySelector('.site-header details.account');
  if (!account) {
    return;
  }
  document.addEventListener('click', e => {
    if (account.open && !account.contains(e.target)) {
      account.open = false;
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && account.open) {
      account.open = false;
      account.querySelector('summary').focus();
    }
  });
})();
