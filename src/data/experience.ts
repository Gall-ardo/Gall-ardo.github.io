export type Advisor = {
  name: string;
  url: string;
};

export type Experience = {
  org: string;
  orgUrl?: string;
  role: string;
  period: string;
  advisors?: Advisor[];
  description: string;
};

export const experience: Experience[] = [
  {
    org: 'EML Group — TUM & Helmholtz',
    orgUrl: 'https://www.eml-munich.de/',
    role: 'Research Intern',
    period: 'February 2026 – Present',
    advisors: [{ name: 'Prof. Zeynep Akata', url: 'https://www.eml-munich.de/people/zeynep-akata' }],
    description:
      'Training Sparse Autoencoders on vision-language models to extract interpretable features, and examining whether societal harm benchmarks capture real-world harm or rely on narrow proxies like refusal rates and stereotypical MCQ selection.',
  },
  {
    org: 'HUCVL',
    orgUrl: 'https://vision.cs.hacettepe.edu.tr/',
    role: 'Deep Learning Research Intern',
    period: 'July 2024 – Present',
    advisors: [
      { name: 'Prof. Aykut Erdem', url: 'https://aykuterdem.github.io/' },
      { name: 'Prof. Erkut Erdem', url: 'https://web.cs.hacettepe.edu.tr/~erkut/' },
    ],
    description:
      'Researching low-light image enhancement with diffusion-based generative models, building a synthetic data pipeline for varying illumination and noise conditions and exploring physics-guided priors for perceptual quality.',
  },
  {
    org: 'KUIS AI Center',
    orgUrl: 'https://ai.ku.edu.tr/',
    role: 'Deep Learning Research Intern',
    period: 'May 2025 – May 2026',
    advisors: [
      { name: 'Prof. Aykut Erdem', url: 'https://aykuterdem.github.io/' },
      { name: 'Prof. Erkut Erdem', url: 'https://web.cs.hacettepe.edu.tr/~erkut/' },
    ],
    description:
      'Developing a diffusion-based framework for 360° panoramic video generation, focusing on realistic motion and spatial continuity, and leading evaluation against prior methods.',
  },
  {
    org: 'Ekinsoft',
    orgUrl: 'https://www.ekinsoft.com.tr/',
    role: 'Computer Vision Intern',
    period: 'June 2025 – July 2025',
    description:
      'Optimized CNN and ViT-based object detection on large-scale license plate data and Dockerized end-to-end training and inference pipelines for GPU and edge deployment.',
  },
  {
    org: 'DLR Lab — Bilkent University',
    orgUrl: 'https://dlr.bilkent.edu.tr/',
    role: 'Undergraduate Researcher',
    period: 'September 2024 – March 2025',
    advisors: [{ name: 'Asst. Prof. Ayşegül Dündar', url: 'https://www.cs.bilkent.edu.tr/~adundar/' }],
    description:
      'Worked on text-to-video generation with diffusion models, developing a SAM2-based segmentation pipeline with morphological operations to improve temporal coherence.',
  },
  {
    org: 'Bilkent University',
    orgUrl: 'https://www.bilkent.edu.tr/',
    role: 'Lab Tutor',
    period: 'October 2023 – May 2024',
    description:
      'Led lab sections for CS115 (Python) and CS101 (Java), covering algorithms, data structures, and object-oriented programming.',
  },
];
