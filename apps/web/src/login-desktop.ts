import { api, ApiError, type Job, type Profile } from './api';

/** Use the normal mode-change job so login runs in ordinary Chrome, including old running instances. */
export async function prepareLoginDesktop(profileId: string): Promise<Profile> {
  let profile = await api<Profile>(`/profiles/${profileId}`);
  if (profile.browserMode !== 'vnc' || (profile.state === 'running' && profile.health?.browserMode !== 'vnc')) {
    const job = await api<Job>(`/profiles/${profileId}/browser-mode`, 'PUT', { browserMode: 'vnc' });
    const deadline = Date.now() + 180000;
    while (true) {
      const current = await api<Job>(`/jobs/${job.id}`);
      if (current.status === 'succeeded') break;
      if (!['queued', 'running'].includes(current.status || '')) throw new ApiError('切换普通 Chrome 失败，请检查实例任务后重试。', 'LOGIN_MODE_FAILED');
      if (Date.now() >= deadline) throw new ApiError('切换普通 Chrome 尚未完成，请稍后重新打开登录桌面。', 'LOGIN_MODE_PENDING');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    profile = await api<Profile>(`/profiles/${profileId}`);
  }
  if (profile.browserMode !== 'vnc' || (profile.state === 'running' && profile.health?.browserMode !== 'vnc'))
    throw new ApiError('实例尚未确认运行在普通 Chrome 模式，请稍后重试。', 'LOGIN_MODE_UNCONFIRMED');
  return profile;
}
