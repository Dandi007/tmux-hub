#!/bin/bash
# hub-sandbox 出网收口（docs/specs/002-sandbox-instance.md §2.5）：
# 容器只能连宿主 192.168.250.1:7898（mihomo sandbox listener），其余一律丢弃。
# 幂等：先删掉带 hub-sandbox 注释的旧规则，再按固定位置插入。
#   firewall.sh        加载
#   firewall.sh --off  只删除
set -euo pipefail

NET=192.168.250.0/24
PROXY_PORT=7898
TAG=hub-sandbox

for chain in DOCKER-USER INPUT; do
  iptables -S "$chain" 2>/dev/null | { grep -F -- "--comment $TAG" || true; } | sed 's/^-A /-D /' |
    while read -r rule; do eval "iptables $rule"; done
done
[ "${1:-}" = "--off" ] && exit 0

iptables -N DOCKER-USER 2>/dev/null || true
c=(-m comment --comment "$TAG")
# 显式写位置号：多次 -I 不带位置会倒序插入，DROP 会跑到放行规则前面。
iptables -I DOCKER-USER 1 -s "$NET" -m conntrack --ctstate ESTABLISHED,RELATED "${c[@]}" -j RETURN
iptables -I DOCKER-USER 2 -s "$NET" "${c[@]}" -j DROP
iptables -I INPUT 1 -s "$NET" -m conntrack --ctstate ESTABLISHED,RELATED "${c[@]}" -j ACCEPT
iptables -I INPUT 2 -s "$NET" -p tcp --dport "$PROXY_PORT" "${c[@]}" -j ACCEPT
iptables -I INPUT 3 -s "$NET" "${c[@]}" -j DROP
# mihomo 的 sandbox listener 绑 0.0.0.0（mihomo 先于 docker 启动），只许 sandbox 网段连。
iptables -I INPUT 4 ! -s "$NET" -p tcp --dport "$PROXY_PORT" "${c[@]}" -j DROP
