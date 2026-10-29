// 利用者が作る共有パック（packs.kind = 'community'）の管理ポリシー（docs/resources.md）。
// SRC の素材の慣習（GSC の画像パックの「丸投げ」「非登録式」など）に倣い、パックごとに 1 つ決める。投稿者は投稿するときに同意する
export type PolicyId = 'free' | 'credit' | 'individual';

export type Policy = {
  id: PolicyId;
  title: string;
  /** パックの条件の既定の文（packs.license） */
  license: string;
  /** 投稿するときに同意してもらう内容 */
  agreement: string;
  /** 投稿ごとの条件（pack_submissions.license）を必ず書くか */
  requiresLicense: boolean;
};

export const POLICIES: Record<PolicyId, Policy> = {
  free: {
    id: 'free',
    title: '自由（丸投げ）',
    license: '利用・改変・再配布（シナリオへの添付、ほかの素材サイトへの投稿を含む）は自由。作者の表記も要らない。',
    agreement: 'この投稿の素材の利用・改変・再配布（シナリオへの添付、ほかの素材サイトへの投稿を含む）を、条件を付けずに誰にでも認めます。',
    requiresLicense: false,
  },
  credit: {
    id: 'credit',
    title: '作者表記（非登録式）',
    license: '利用・改変・シナリオへの添付は自由。使ったシナリオの ReadMe などに作者名とパックの頁の URL を書く。作者から差し替え・削除の申し出があれば応じる。',
    agreement: 'この投稿の素材の利用・改変・シナリオへの添付を認めます。使う人はシナリオの ReadMe などに作者名とパックの頁の URL を書きます。',
    requiresLicense: false,
  },
  individual: {
    id: 'individual',
    title: '個別の条件',
    license: '投稿ごとの「ライセンス・配布の条件」に従う。SRC#Site でシナリオと一緒に読み込んで遊ぶことは、どの投稿でも認められている。',
    agreement: 'この投稿の素材を、下に書く「ライセンス・配布の条件」で公開します。SRC#Site でシナリオと一緒に読み込んで遊ぶことは認めます。',
    requiresLicense: true,
  },
};

export function policyOf(id: string | null | undefined): Policy | null {
  return id && id in POLICIES ? POLICIES[id as PolicyId] : null;
}
