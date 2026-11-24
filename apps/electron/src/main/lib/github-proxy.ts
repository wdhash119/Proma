/**
 * GitHub 国内网络回退的共享工具（纯函数，无 IO）。
 *
 * 镜像能力实测结论（2026-11-24，国内网络本机验证）：
 * - gh-proxy.com：支持 api.github.com JSON 与带 tag 的 release 文件；
 *   不支持 `/releases/latest/download/` 重定向端点（返回 404）。
 * - ghfast.top：支持带 tag 的 release 文件与 latest/download 重定向；
 *   不支持 api.github.com（返回 403 Invalid input）。
 *
 * 因此：API 回退只用 gh-proxy；更新 feed 统一用「带 tag 的 download 路径」，
 * 两个文件镜像都能取到 latest.yml 与安装包。
 */

/** release 文件代理镜像（按优先级排序，均以 / 结尾） */
export const GITHUB_FILE_PROXY_MIRRORS: readonly string[] = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
]

/** API JSON 代理镜像（实测仅 gh-proxy 支持 api.github.com） */
export const GITHUB_API_PROXY_MIRRORS: readonly string[] = ['https://gh-proxy.com/']

/** 把 GitHub URL 挂到代理镜像后面：mirror 以 / 结尾，url 以 https:// 开头 */
export function proxiedGitHubUrl(mirror: string, url: string): string {
  return `${mirror}${url}`
}

/**
 * 更新 feed 的代理地址：带 tag 的 download 目录。
 * electron-updater 的 generic provider 在其下取 latest.yml 与安装包文件。
 */
export function proxiedReleaseFeedUrl(mirror: string, owner: string, repo: string, tag: string): string {
  return proxiedGitHubUrl(mirror, `https://github.com/${owner}/${repo}/releases/download/${tag}`)
}

const NETWORK_ERROR_PATTERN =
  /net::ERR_|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed|getaddrinfo|timed? ?out|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_PROXY|502 Bad Gateway|503 Service|504 Gateway/i

/** 是否像网络连通性错误（值得换代理重试），区别于 404、限流等真实响应 */
export function isNetworkErrorMessage(message: string): boolean {
  return NETWORK_ERROR_PATTERN.test(message)
}

/** 是否是「release 缺少 latest.yml」这类换代理也无济于事的错误 */
export function isMissingFeedErrorMessage(message: string): boolean {
  return /404|cannot find latest|not found/i.test(message)
}