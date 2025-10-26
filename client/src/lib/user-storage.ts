const USER_ID_KEY = 'pmp_user_id';

export function getDeviceUserId(): string {
  let userId = localStorage.getItem(USER_ID_KEY);
  
  if (!userId) {
    userId = generateDeviceId();
    localStorage.setItem(USER_ID_KEY, userId);
  }
  
  return userId;
}

function generateDeviceId(): string {
  return 'pmp_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

export function clearDeviceUserId(): void {
  localStorage.removeItem(USER_ID_KEY);
}
