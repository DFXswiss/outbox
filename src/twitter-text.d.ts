declare module 'twitter-text' {
  const twitterText: { parseTweet(text: string): { weightedLength: number } }
  export default twitterText
}
