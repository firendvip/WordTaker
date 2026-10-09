import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MembershipHero } from '../src/components/account/MembershipHero';

vi.mock('../src/components/account/QuotaCard', () => ({ QuotaCard: () => null }));
vi.mock('../src/components/account/InviteCard', () => ({ InviteCard: () => null }));
vi.mock('../src/components/account/RedeemCard', () => ({ RedeemCard: () => null }));

describe('phone-only membership identity', () => {
  it.each([
    [{ phone: '13800138000' }, '13800138000', '手机验证码登录'],
    [{ phone: '13800138000', nickname: '小猫用户' }, '小猫用户', '手机验证码登录'],
    [{}, '已登录用户', '已登录'],
  ])('renders the phone account label for %j', (account, name, method) => {
    const html = renderToStaticMarkup(<MembershipHero account={account} />);
    expect(html).toContain(name);
    expect(html).toContain(method);
    expect(html).not.toMatch(/邮箱登录|微信登录/);
  });
});
