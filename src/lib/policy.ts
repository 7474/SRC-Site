// 投稿素材のパック（packs.kind = 'community'）の管理ポリシー（docs/resources.md）。
// SRC の素材の慣習（GSC の画像パックの「丸投げ」「非登録式」など）に倣い、パックごとに 1 つ決める。投稿者は投稿先のパックでポリシーを選ぶ
export type PolicyId = 'free' | 'credit' | 'individual';

export type Policy = {
  id: PolicyId;
  title: string;
  /** 投稿するときに同意してもらう内容 */
  agreement: string;
  /** 素材ごとの条件（scenarios.license）を必ず書くか */
  requiresLicense: boolean;
};

export const POLICIES: Record<PolicyId, Policy> = {
  free: {
    id: 'free',
    title: '自由（丸投げ）',
    agreement: 'この素材の利用・改変・再配布（シナリオへの添付、ほかの素材サイトへの投稿を含む）を、条件を付けずに誰にでも認めます。',
    requiresLicense: false,
  },
  credit: {
    id: 'credit',
    title: '作者表記（非登録式）',
    agreement: 'この素材の利用・改変・シナリオへの添付を認めます。使う人はシナリオの ReadMe などに作者名と素材の頁の URL を書きます。',
    requiresLicense: false,
  },
  individual: {
    id: 'individual',
    title: '個別の条件',
    agreement: 'この素材を、下に書く「ライセンス・配布の条件」で公開します。SRC#Site でシナリオと一緒に読み込んで遊ぶことは認めます。',
    requiresLicense: true,
  },
};

export function policyOf(id: string | null | undefined): Policy | null {
  return id && id in POLICIES ? POLICIES[id as PolicyId] : null;
}
