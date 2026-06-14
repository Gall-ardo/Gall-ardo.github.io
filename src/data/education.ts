export type Education = {
  institution: string;
  degree: string;
  period: string;
  description?: string;
};

export const education: Education[] = [
  {
    institution: 'Bilkent University',
    degree: 'B.S. in Computer Science',
    period: '2022 – 2027 (expected)',
  },
  {
    institution: 'Instituto Universitário de Lisboa',
    degree: 'Erasmus+ Exchange — Computer Science',
    period: 'Sep 2025 – Jan 2026',
  },
];
