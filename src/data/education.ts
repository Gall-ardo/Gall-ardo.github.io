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
    degree: 'Computer Science',
    period: 'Erasmus+ Exchange Program · September 2025 – January 2026',
  },
];
