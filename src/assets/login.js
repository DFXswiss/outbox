function utf8ToHex(text) {
  const bytes = new TextEncoder().encode(text)
  let hex = '0x'
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

const button = document.querySelector('#wallet-login')
const message = document.querySelector('#wallet-message')

if (!window.ethereum) {
  message.textContent = 'No wallet found. Install or enable a browser wallet.'
  button.disabled = true
} else {
  button.addEventListener('click', async () => {
    button.disabled = true
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' })
      const address = accounts[0]
      if (!address) throw new Error('No wallet address found.')
      const challenge = await fetch(`/auth/wallet/message?address=${encodeURIComponent(address)}`)
      if (!challenge.ok) throw new Error('Sign-in not possible.')
      const { message: text } = await challenge.json()
      const signature = await window.ethereum.request({ method: 'personal_sign', params: [utf8ToHex(text), address] })
      const response = await fetch('/auth/wallet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, signature }) })
      if (!response.ok) throw new Error('Sign-in not possible.')
      location.href = '/'
    } catch {
      message.textContent = 'Sign-in not possible.'
      button.disabled = false
    }
  })
}
